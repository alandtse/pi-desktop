import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { isValidPackageSpec } from '../../shared/package-spec'
import { fetchPackageCatalog } from '../package-catalog'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { assertTrustedSender, isString } from './validation'
import { runPiCli, type PiCliStreamOptions } from './run-pi-cli'
import {
  beginPackageUpdate,
  cancelPackageUpdate,
  endPackageUpdate,
  setPackageUpdateEmitter,
  updatePackageProgress,
  type PackageUpdateRun,
} from '../package-update-progress'
import { activeEngineKind } from './active-engine'
import { parseOmpPluginList, type OmpNpmPlugin } from '../omp-plugin-list'
import {
  explainOmpFailure,
  findPackageUpdates,
  ompNpmTargets,
  OmpPluginListError,
  ompUpdateInstallSpec,
  piRegistryQuery,
  PI_UPDATE_ALL_ARGS,
  type OmpNpmTarget,
  type OmpRegistryQuery,
  type UpdateCandidate,
} from '../package-updates'
import type { AgentEngineKind, InstalledPackage, PackageUpdate } from '../../shared/ipc-contracts'
import type { IpcContext } from './context'
import { t } from '../../shared/i18n'

export function registerPackageHandlers(ctx: IpcContext): void {
  const { workspaceManager } = ctx
  setPackageUpdateEmitter((progress) => ctx.broadcast(IPC_CHANNELS.EVENT_PACKAGE_UPDATE_PROGRESS, progress))

  // ─── Package Management ─────────────────────────────────────────────────

  // Package actions target the engine the user is looking at, and run that
  // engine's own CLI — a session from the other store can be active while a
  // different engine is the configured default.
  const activeEngine = (): AgentEngineKind => activeEngineKind(workspaceManager)

  ipcMain.handle(IPC_CHANNELS.PACKAGE_LIST_INSTALLED, async () => {
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    return listInstalledPackages(cwd, activeEngine())
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGE_INSTALL, async (event, packageSpec: unknown) => {
    assertTrustedSender(event)
    if (!isString(packageSpec)) throw new Error('packageSpec must be a string')
    if (!isValidPackageSpec(packageSpec)) throw new Error(t('errors.packages.invalidSpec'))
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    return installPackage(packageSpec, cwd, activeEngine())
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGE_REMOVE, async (event, packageSpec: unknown) => {
    assertTrustedSender(event)
    if (!isString(packageSpec)) throw new Error('packageSpec must be a string')
    if (!isValidPackageSpec(packageSpec)) throw new Error(t('errors.packages.invalidSpec'))
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    return removePackage(packageSpec, cwd, activeEngine())
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGE_UPDATE, async (event, packageSpec: unknown) => {
    assertTrustedSender(event)
    if (!isString(packageSpec)) throw new Error('packageSpec must be a string')
    if (!isValidPackageSpec(packageSpec)) throw new Error(t('errors.packages.invalidSpec'))
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    const engine = activeEngine()
    const run = beginPackageUpdate(engine, packageSpec)
    try {
      updatePackageProgress(run, { phase: 'running' })
      const result = await updatePackage(packageSpec, cwd, engine, streamOptions(run))
      endPackageUpdate(run, { success: result.success, error: result.success ? undefined : result.output })
      return result
    } catch (error) {
      endPackageUpdate(run, { success: false, error: describeError(error) })
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGE_UPDATE_ALL, async (event) => {
    assertTrustedSender(event)
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    const engine = activeEngine()
    const run = beginPackageUpdate(engine, 'all')
    try {
      // Replacing the Pi CLI (and the shared npm tree its packages live in)
      // while a session runtime has it loaded is what this wait prevents, and
      // it is also what made the old silent version look hung: name that state.
      if (engine === 'pi' && !(await waitForAgentRuntimesToStop(workspaceManager, run))) {
        return { success: false, output: t('errors.packages.updateCancelled') }
      }
      updatePackageProgress(run, { phase: 'running' })
      const result = await updateAllPackages(cwd, engine, run)
      endPackageUpdate(run, { success: result.success, error: result.success ? undefined : result.output })
      return result
    } catch (error) {
      endPackageUpdate(run, { success: false, error: describeError(error) })
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGE_UPDATE_CANCEL, async (event) => {
    assertTrustedSender(event)
    return cancelPackageUpdate()
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGE_CHECK_UPDATES, async () => {
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    return checkPackageUpdates(cwd, activeEngine())
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGE_CATALOG_FETCH, async (_event, query?: unknown) => {
    return fetchPackageCatalog(isString(query) ? query : undefined)
  })
}

// ─── Package Management ──────────────────────────────────────────────────────

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Stream each CLI line to the progress event; the run's signal cancels it. */
function streamOptions(run: PackageUpdateRun): PiCliStreamOptions {
  return {
    signal: run.controller.signal,
    onLine: (line) => updatePackageProgress(run, { phase: 'output', line }),
  }
}

/**
 * Defer replacement of the CLI/package installation until no agent process uses
 * it, reporting a live count so the UI can say what it is waiting for.
 * Returns false when the user cancelled during the wait.
 */
async function waitForAgentRuntimesToStop(
  workspaceManager: IpcContext['workspaceManager'],
  run: PackageUpdateRun,
): Promise<boolean> {
  for (;;) {
    if (run.controller.signal.aborted) return false
    const waitingRuntimes = workspaceManager.getSessionRuntimes().filter((runtime) =>
      runtime.status === 'starting' || runtime.status === 'running'
    ).length
    if (waitingRuntimes === 0) return true
    updatePackageProgress(run, { phase: 'waiting-for-runtimes', waitingRuntimes })
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
  }
}

const LIST_TIMEOUT_MS = 30_000
const INSTALL_TIMEOUT_MS = 120_000
const REMOVE_TIMEOUT_MS = 30_000
const UPDATE_TIMEOUT_MS = 120_000
// Updating every package runs one install per outdated package.
const UPDATE_ALL_TIMEOUT_MS = 300_000

const OMP_PLUGIN_LIST_ARGS = ['plugin', 'list', '--json']
// Without a plugin id, OMP upgrades every outdated marketplace plugin.
const OMP_MARKETPLACE_UPGRADE_ARGS = ['plugin', 'upgrade']

type CliResult = { success: boolean; output: string }

interface PiPackageScope {
  scope: 'global' | 'project'
  settingsPath: string
  npmRoot: string
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? ''
}

function ompPluginsDir(): string {
  return join(homeDir(), '.omp', 'plugins')
}

/** Pi's package scopes: each has a settings `packages` array and a shared npm project. */
function piPackageScopes(cwd: string): PiPackageScope[] {
  const agentDir = join(homeDir(), '.pi', 'agent')
  const projectDir = join(cwd, '.pi')
  return [
    { scope: 'global', settingsPath: join(agentDir, 'settings.json'), npmRoot: join(agentDir, 'npm') },
    { scope: 'project', settingsPath: join(projectDir, 'settings.json'), npmRoot: join(projectDir, 'npm') },
  ]
}

async function listInstalledPackages(cwd: string, engine: AgentEngineKind): Promise<InstalledPackage[]> {
  try {
    if (engine === 'omp') return listOmpPlugins(cwd)
    const packages: InstalledPackage[] = []
    for (const { scope, settingsPath } of piPackageScopes(cwd)) {
      const scopePackages = await readPackagesFromSettings(settingsPath)
      packages.push(...scopePackages.map((p) => ({ ...p, scope })))
    }
    return packages
  } catch {
    return []
  }
}

/**
 * OMP does not track packages in a settings.json `packages` array — its plugin
 * store lives in `~/.omp/plugins/` — so the installed list comes from the CLI.
 */
async function listOmpPlugins(cwd: string): Promise<InstalledPackage[]> {
  const result = await runPiCli(OMP_PLUGIN_LIST_ARGS, cwd, LIST_TIMEOUT_MS, 'omp')
  if (!result.success) return []
  return parseOmpPluginList(result.output, ompPluginsDir())
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function readPackageVersion(packageJsonPath: string): Promise<string | null> {
  const version = (await readJsonObject(packageJsonPath))?.version
  return typeof version === 'string' ? version : null
}

async function piUpdateCandidates(cwd: string): Promise<UpdateCandidate[]> {
  const candidates: UpdateCandidate[] = []
  for (const { settingsPath, npmRoot } of piPackageScopes(cwd)) {
    for (const pkg of await readPackagesFromSettings(settingsPath)) {
      const query = piRegistryQuery(pkg.source)
      if (!query) continue
      const installedVersion = await readPackageVersion(join(npmRoot, 'node_modules', query.name, 'package.json'))
      if (installedVersion) candidates.push({ source: pkg.source, query, installedVersion })
    }
  }
  return candidates
}

/**
 * OMP's npm plugins with their registry lookups. The lookup comes from the
 * plugin store's package.json, which records how each plugin was installed.
 */
async function readOmpNpmTargets(cwd: string): Promise<OmpNpmTarget[]> {
  const result = await runPiCli(OMP_PLUGIN_LIST_ARGS, cwd, LIST_TIMEOUT_MS, 'omp')
  const manifest = await readJsonObject(join(ompPluginsDir(), 'package.json'))
  return ompNpmTargets(result, (manifest?.dependencies ?? {}) as Record<string, unknown>)
}

/** Run an OMP mutation that needs the npm plugin list; a failed list is the result. */
async function withOmpNpmTargets(
  cwd: string,
  mutate: (targets: OmpNpmTarget[]) => Promise<CliResult>
): Promise<CliResult> {
  let targets: OmpNpmTarget[]
  try {
    targets = await readOmpNpmTargets(cwd)
  } catch (error) {
    if (!(error instanceof OmpPluginListError)) throw error
    return { success: false, output: t('errors.packages.listFailed', { detail: error.detail }) }
  }
  return mutate(targets)
}
function ompUpdateCandidates(targets: OmpNpmTarget[]): UpdateCandidate[] {
  return targets.flatMap(({ plugin, query }) =>
    query && plugin.version ? [{ source: plugin.name, query, installedVersion: plugin.version }] : []
  )
}

async function checkPackageUpdates(cwd: string, engine: AgentEngineKind): Promise<PackageUpdate[]> {
  const candidates = engine === 'omp'
    ? ompUpdateCandidates(await readOmpNpmTargets(cwd))
    : await piUpdateCandidates(cwd)
  return findPackageUpdates(candidates)
}

function combineResults(results: CliResult[]): CliResult {
  return {
    success: results.every((result) => result.success),
    output: results.map((result) => result.output.trim()).filter(Boolean).join('\n\n'),
  }
}

function withOmpFailureExplained(result: CliResult, engine: AgentEngineKind): CliResult {
  return engine === 'omp' && !result.success ? { ...result, output: explainOmpFailure(result.output) } : result
}

/** Run an OMP command that changes the plugin store. */
async function runOmpMutation(
  args: string[],
  cwd: string,
  timeout: number,
  options?: PiCliStreamOptions,
): Promise<CliResult> {
  return withOmpFailureExplained(await runPiCli(args, cwd, timeout, 'omp', options), 'omp')
}

/**
 * OMP has no update command for npm plugins, so an update reinstalls from the
 * registry. The install spec carries the feature selection; `omp install`
 * also re-enables the plugin, so a disabled plugin is disabled again.
 */
async function updateOmpNpmPlugin(
  plugin: OmpNpmPlugin,
  query: OmpRegistryQuery,
  cwd: string,
  options?: PiCliStreamOptions,
): Promise<CliResult> {
  const install = await runOmpMutation(
    ['install', ompUpdateInstallSpec(query, plugin)],
    cwd,
    UPDATE_TIMEOUT_MS,
    options,
  )
  if (!install.success || plugin.enabled) return install
  const disable = await runOmpMutation(['plugin', 'disable', plugin.name], cwd, UPDATE_TIMEOUT_MS, options)
  return combineResults([install, disable])
}

async function updateOmpPlugin(
  spec: string,
  cwd: string,
  options?: PiCliStreamOptions,
): Promise<CliResult> {
  return withOmpNpmTargets(cwd, async (targets) => {
    const target = targets.find(({ plugin }) => plugin.name === spec)
    // Not an npm plugin: marketplace ids (`name@marketplace`) have a native upgrade.
    if (!target) return runOmpMutation(['plugin', 'upgrade', spec], cwd, UPDATE_TIMEOUT_MS, options)
    if (!target.query) {
      return { success: false, output: t('errors.packages.pinnedOrNotFromNpm', { spec }) }
    }
    return updateOmpNpmPlugin(target.plugin, target.query, cwd, options)
  })
}

async function updateAllOmpPlugins(
  cwd: string,
  run: PackageUpdateRun,
  options: PiCliStreamOptions,
): Promise<CliResult> {
  return withOmpNpmTargets(cwd, async (targets) => {
    const outdated = new Set((await findPackageUpdates(ompUpdateCandidates(targets))).map((update) => update.source))
    const plugins = targets.filter(({ plugin, query }) => query && outdated.has(plugin.name))
    // One marketplace upgrade plus one reinstall per outdated npm plugin: the
    // only path here where a real step total exists.
    const total = plugins.length + 1
    updatePackageProgress(run, { phase: 'running', completed: 0, total })
    const results = [await runOmpMutation(OMP_MARKETPLACE_UPGRADE_ARGS, cwd, UPDATE_ALL_TIMEOUT_MS, options)]
    updatePackageProgress(run, { phase: 'running', completed: 1, total })
    // Sequential: every npm plugin shares one bun project and lockfile.
    for (const [index, { plugin, query }] of plugins.entries()) {
      if (!query) continue
      updatePackageProgress(run, { phase: 'running', target: plugin.name, completed: index + 1, total })
      results.push(await updateOmpNpmPlugin(plugin, query, cwd, options))
      updatePackageProgress(run, { phase: 'running', completed: index + 2, total })
    }
    return combineResults(results)
  })
}

async function readPackagesFromSettings(settingsPath: string): Promise<InstalledPackage[]> {
  const packageEntries = (await readJsonObject(settingsPath))?.packages
  if (!Array.isArray(packageEntries)) return []
  return packageEntries.map((entry: unknown): InstalledPackage => {
    if (typeof entry === 'string') {
      return {
        name: extractPackageName(entry),
        source: entry,
        type: 'package',
        version: extractVersion(entry),
        path: settingsPath,
      }
    }
    if (typeof entry === 'object' && entry !== null) {
      const e = entry as Record<string, unknown>
      return {
        name: extractPackageName(String(e.source ?? '')),
        source: String(e.source ?? ''),
        type: 'package',
        version: extractVersion(String(e.source ?? '')),
        path: settingsPath,
      }
    }
    return { name: 'unknown', source: String(entry), type: 'package', version: null, path: settingsPath }
  })
}

function extractPackageName(source: string): string {
  // npm:@scope/name@1.0.0 -> @scope/name
  // npm:name@1.0.0 -> name
  // git:github.com/user/repo -> user/repo
  const npmMatch = source.match(/^npm:(@?[^@]+)/)
  if (npmMatch) return npmMatch[1]

  const gitMatch = source.match(/github\.com\/([^/]+\/[^/@]+)/)
  if (gitMatch) return gitMatch[1]

  return source.split('/').pop() ?? source
}

function extractVersion(source: string): string | null {
  const match = source.match(/@([^/]+)$/)
  return match ? match[1] : null
}

async function installPackage(spec: string, cwd: string, engine: AgentEngineKind): Promise<CliResult> {
  return withOmpFailureExplained(await runPiCli(['install', spec], cwd, INSTALL_TIMEOUT_MS, engine), engine)
}

async function removePackage(spec: string, cwd: string, engine: AgentEngineKind): Promise<CliResult> {
  return runPiCli(['remove', spec], cwd, REMOVE_TIMEOUT_MS, engine)
}

async function updatePackage(
  spec: string,
  cwd: string,
  engine: AgentEngineKind,
  options?: PiCliStreamOptions,
): Promise<CliResult> {
  if (engine === 'omp') return updateOmpPlugin(spec, cwd, options)
  return runPiCli(['update', spec], cwd, UPDATE_TIMEOUT_MS, engine, options)
}

async function updateAllPackages(
  cwd: string,
  engine: AgentEngineKind,
  run: PackageUpdateRun,
): Promise<CliResult> {
  const options = streamOptions(run)
  if (engine === 'omp') return updateAllOmpPlugins(cwd, run, options)
  return runPiCli([...PI_UPDATE_ALL_ARGS], cwd, UPDATE_ALL_TIMEOUT_MS, engine, options)
}
