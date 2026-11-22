import type { AgentEngineKind, PackageUpdateProgress } from '../shared/ipc-contracts'

/**
 * Progress for the one package mutation the Packages view can start at a time.
 *
 * Main owns the state because the long parts happen there: waiting for agent
 * runtimes to stop before replacing the Pi CLI, and the CLI's own output. The
 * renderer mirrors it from the event stream, so the bar keeps working when the
 * Packages view is closed and reopened mid-run.
 */
export interface PackageUpdateRun {
  runId: number
  engine: AgentEngineKind
  target: string
  controller: AbortController
}

type Emit = (progress: PackageUpdateProgress) => void

let nextRunId = 1
let active: PackageUpdateRun | null = null
let emit: Emit = () => {}

/** Wire the broadcast in once, at IPC registration time. */
export function setPackageUpdateEmitter(broadcast: Emit): void {
  emit = broadcast
}

/** The run in flight (also the cancel handle), or null. */
export function getActivePackageUpdateRun(): PackageUpdateRun | null {
  return active
}

function report(progress: PackageUpdateProgress): void {
  emit(progress)
}

/** Start a run: supersedes any previous one (which is aborted) and reports `preparing`. */
export function beginPackageUpdate(engine: AgentEngineKind, target: string): PackageUpdateRun {
  active?.controller.abort()
  const run: PackageUpdateRun = {
    runId: nextRunId++,
    engine,
    target,
    controller: new AbortController(),
  }
  active = run
  report({ runId: run.runId, phase: 'preparing', target, engine })
  return run
}

/**
 * Report a step of an active run. `target` may be overridden: an "update all"
 * moves through one package at a time (OMP renames each plugin), so the label
 * follows the step rather than staying "all".
 */
export function updatePackageProgress(
  run: PackageUpdateRun,
  progress: Omit<PackageUpdateProgress, 'runId' | 'engine' | 'target'> & { target?: string },
): void {
  // A late line from an aborted run must not overwrite the run that replaced it.
  if (active?.runId !== run.runId) return
  report({ ...progress, runId: run.runId, target: progress.target ?? run.target, engine: run.engine })
}

export function endPackageUpdate(
  run: PackageUpdateRun,
  result: { success: boolean; error?: string; cancelled?: boolean },
): void {
  if (active?.runId !== run.runId) return
  active = null
  report({
    runId: run.runId,
    target: run.target,
    engine: run.engine,
    phase: result.cancelled ? 'cancelled' : 'done',
    success: result.success,
    ...(result.error ? { error: result.error } : {}),
  })
}

/** Abort whatever runs. Returns whether there was something to abort. */
export function cancelPackageUpdate(): boolean {
  const run = active
  if (!run) return false
  run.controller.abort()
  active = null
  report({
    runId: run.runId,
    target: run.target,
    engine: run.engine,
    phase: 'cancelled',
    success: false,
  })
  return true
}
