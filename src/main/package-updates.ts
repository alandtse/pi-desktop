import type { PackageUpdate } from '../shared/ipc-contracts'
import { isNewerVersion } from '../shared/version-compare'
import { parseOmpNpmPlugins, type OmpNpmPlugin } from './omp-plugin-list'
import { t } from '../shared/i18n'

/**
 * Update detection for installed packages.
 *
 * Neither engine's CLI reports available updates, so the GUI compares each
 * installed npm package with the version its dist-tag resolves to on the npm
 * registry. Only packages whose update target is knowable are checked: git and
 * local sources have no registry version, and exact-version pins never move on
 * update. Everything here is pure except `fetchRegistryVersion`, which takes an
 * injectable fetch.
 */

const NPM_REGISTRY_URL = 'https://registry.npmjs.org'
const REGISTRY_TIMEOUT_MS = 8000
const LATEST_TAG = 'latest'
const NPM_SOURCE_PREFIX = 'npm:'
const ANY_VERSION_RANGE = '*'
// A dist-tag starts with a letter (latest, next, beta); exact versions and
// ranges start with a digit or an operator, and the registry answers neither
// as a moving target.
const DIST_TAG_PATTERN = /^[A-Za-z][\w.-]*$/
// Caret and tilde ranges — what bun writes for an unpinned install.
const FLOATING_RANGE_PATTERN = /^[\^~]\d/
const OMP_MISSING_BUN_MARKER = 'Executable not found in $PATH: "bun"'

/** Pi's built-in update command updates the CLI and all installed extensions. */
export const PI_UPDATE_ALL_ARGS = ['update', '--all', '--no-approve'] as const

/** A registry lookup: the package name and the dist-tag its update follows. */
export interface RegistryQuery {
  name: string
  tag: string
}

/**
 * An OMP plugin's registry lookup plus the prefix its store entry uses
 * (`npm:` or none). The update spec must keep that prefix: bun treats the two
 * forms as different dependencies, and mixing them can hang the install.
 */
export interface OmpRegistryQuery extends RegistryQuery {
  specPrefix: string
}

/** One installed package to check against the registry. */
export interface UpdateCandidate {
  source: string
  query: RegistryQuery
  installedVersion: string
}

export type RegistryVersionLookup = (query: RegistryQuery) => Promise<string | null>

/** An installed OMP npm plugin and its registry lookup (null when pinned). */
export interface OmpNpmTarget {
  plugin: OmpNpmPlugin
  query: OmpRegistryQuery | null
}

/** `omp plugin list --json` did not run, so the npm plugins are unknown. */
export class OmpPluginListError extends Error {
  constructor(readonly detail: string) {
    super(`omp plugin list failed: ${detail}`)
    this.name = 'OmpPluginListError'
  }
}

/**
 * OMP's npm plugins with their registry lookups. The lookup comes from the
 * plugin store's `dependencies`, which record how each plugin was installed.
 * A failed list is an error, never an empty list: callers would otherwise
 * treat every npm plugin as a marketplace one or report no updates.
 */
export function ompNpmTargets(
  list: { success: boolean; output: string },
  dependencies: Record<string, unknown>
): OmpNpmTarget[] {
  if (!list.success) throw new OmpPluginListError(list.output.trim())
  return parseOmpNpmPlugins(list.output).map((plugin) => {
    const dependencySpec = dependencies[plugin.name]
    return {
      plugin,
      query: typeof dependencySpec === 'string' ? ompRegistryQuery(plugin.name, dependencySpec) : null,
    }
  })
}

/** Split `name@version` (scoped or not) into its name and version parts. */
function splitNameAndVersion(spec: string): { name: string; version: string } {
  // Start past index 0 so a scope's leading `@` is not read as the separator.
  const separator = spec.indexOf('@', 1)
  return separator === -1
    ? { name: spec, version: '' }
    : { name: spec.slice(0, separator), version: spec.slice(separator + 1) }
}

function distTagFor(version: string): string | null {
  if (version === '') return LATEST_TAG
  return DIST_TAG_PATTERN.test(version) ? version : null
}

/**
 * The registry lookup for a Pi settings source such as `npm:name` or
 * `npm:@scope/name@next`. Pi updates unpinned npm sources to the version their
 * tag resolves to, so that version is the update target. Returns null for git
 * and local sources, exact pins, and ranges.
 */
export function piRegistryQuery(source: string): RegistryQuery | null {
  if (!source.startsWith(NPM_SOURCE_PREFIX)) return null
  const { name, version } = splitNameAndVersion(source.slice(NPM_SOURCE_PREFIX.length))
  const tag = distTagFor(version)
  return name && tag ? { name, tag } : null
}

/**
 * The registry lookup for an OMP npm plugin, from its entry in the plugin
 * store's package.json (`"name": "npm:name@^1.2.0"` or `"name": "^1.2.0"`).
 * A floating range is updated by reinstalling from `latest`; a dist-tag keeps
 * its tag. Returns null for exact pins and for git, file and link installs,
 * which a registry reinstall would replace with a different source.
 */
export function ompRegistryQuery(pluginName: string, dependencySpec: string): OmpRegistryQuery | null {
  const specPrefix = dependencySpec.startsWith(NPM_SOURCE_PREFIX) ? NPM_SOURCE_PREFIX : ''
  const { name, version } = specPrefix
    ? splitNameAndVersion(dependencySpec.slice(specPrefix.length))
    : { name: pluginName, version: dependencySpec }
  const tag = version === ANY_VERSION_RANGE || FLOATING_RANGE_PATTERN.test(version)
    ? LATEST_TAG
    : distTagFor(version)
  return name && tag ? { name, tag, specPrefix } : null
}

/** The registry URL that resolves `query.tag` to a version manifest. */
export function registryVersionUrl(query: RegistryQuery): string {
  // The registry expects a scoped name's slash encoded: `@scope%2fname`.
  return `${NPM_REGISTRY_URL}/${query.name.replace('/', '%2f')}/${encodeURIComponent(query.tag)}`
}

/** The version `query.tag` resolves to, or null when the registry can't say. */
export async function fetchRegistryVersion(
  query: RegistryQuery,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  try {
    const response = await fetchImpl(registryVersionUrl(query), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const manifest = (await response.json()) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/** The candidates whose registry version is newer than the installed one. */
export async function findPackageUpdates(
  candidates: UpdateCandidate[],
  lookup: RegistryVersionLookup = fetchRegistryVersion
): Promise<PackageUpdate[]> {
  const results = await Promise.all(
    candidates.map(async (candidate): Promise<PackageUpdate | null> => {
      const latestVersion = await lookup(candidate.query)
      if (!latestVersion || !isNewerVersion(latestVersion, candidate.installedVersion)) return null
      return { source: candidate.source, installedVersion: candidate.installedVersion, latestVersion }
    })
  )
  return results.filter((update): update is PackageUpdate => update !== null)
}

/**
 * The `omp install` spec that updates `plugin` in place. `omp install` resets
 * the plugin's feature selection, so the current one is carried in OMP's
 * bracket syntax: none for defaults, `[]` for no features, `[a,b]` otherwise.
 */
export function ompUpdateInstallSpec(query: OmpRegistryQuery, plugin: OmpNpmPlugin): string {
  const features = plugin.enabledFeatures === null ? '' : `[${plugin.enabledFeatures.join(',')}]`
  return `${query.specPrefix}${query.name}@${query.tag}${features}`
}

/** Replace OMP's missing-bun failure with an actionable message. */
export function explainOmpFailure(output: string): string {
  return output.includes(OMP_MISSING_BUN_MARKER) ? t('errors.packages.missingBun') : output
}
