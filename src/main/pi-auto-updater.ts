import type { WorkspaceManager } from './workspace-manager'
import { runPiCli } from './ipc/run-pi-cli'
import { getPiCliForEngine } from './pi-rpc-manager'
import { appLog } from './app-log'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const STARTUP_DELAY_MS = 30_000
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000

export function shouldRunPiAutoUpdate(input: {
  pending: boolean
  running: boolean
  piInstalled: boolean
  runtimeStatuses: string[]
}): boolean {
  return input.pending && !input.running && input.piInstalled &&
    !input.runtimeStatuses.some((status) => status === 'starting' || status === 'running')
}

/**
 * Periodically invoke Pi's own updater, which checks for and installs CLI and
 * extension updates. Defer while any agent runtime is starting or running so an
 * active process never has its installation changed underneath it.
 */
export function startPiAutoUpdater(workspaceManager: WorkspaceManager): () => void {
  let stopped = false
  let running = false
  let pending = false

  const maybeUpdate = async (): Promise<void> => {
    if (stopped) return
    const piInstalled = getPiCliForEngine('pi').found
    const runtimeStatuses = workspaceManager.getSessionRuntimes().map((runtime) => runtime.status)
    if (!shouldRunPiAutoUpdate({ pending, running, piInstalled, runtimeStatuses })) {
      if (!piInstalled) pending = false
      return
    }

    running = true
    pending = false
    try {
      const workspace = workspaceManager.getActiveWorkspace()
      const result = await runPiCli(
        ['update', '--all', '--no-approve'],
        workspace?.path ?? process.cwd(),
        UPDATE_TIMEOUT_MS,
        'pi',
      )
      if (!result.success) {
        appLog.warn('updates', 'Automatic Pi update failed', { output: result.output })
        pending = true
      } else {
        appLog.info('updates', 'Checked and applied available Pi and extension updates')
      }
    } catch (error) {
      appLog.error('updates', 'Automatic Pi update failed', error)
      pending = true
    } finally {
      running = false
    }
  }

  const onRuntimeChange = (): void => { void maybeUpdate() }
  workspaceManager.onSessionRuntime(onRuntimeChange)

  const startupTimer = setTimeout(() => {
    pending = true
    void maybeUpdate()
  }, STARTUP_DELAY_MS)
  const interval = setInterval(() => {
    pending = true
    void maybeUpdate()
  }, CHECK_INTERVAL_MS)
  startupTimer.unref()
  interval.unref()

  return () => {
    stopped = true
    clearTimeout(startupTimer)
    clearInterval(interval)
  }
}
