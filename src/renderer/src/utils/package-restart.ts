/**
 * Whether a package change needs the engine restarted, and whether it can be.
 *
 * An install, a remove and an update all land on disk only: Pi loads its
 * extensions once, at spawn (`src/main/ipc/package-handlers.ts` never touches a
 * running engine), so a changed package is invisible until the next start. That is
 * why the success message says "restart" — but a message is not a control, and a
 * user told to restart with nowhere to do it reasonably reads the banner as broken.
 *
 * The three states are deliberately distinct, because the honest answer differs:
 * there is something to restart, there is nothing running to restart (so the next
 * start picks the change up on its own and an instruction to restart is noise), or
 * the engine is mid-boot and restarting it now would race the start.
 *
 * This returns a state and nothing else. The wording lives in the locale files, so
 * it is translated like every other string in the renderer.
 */
export type PackageRestartNeed = 'restart' | 'nothingRunning' | 'busy'

export interface PackageRestartInput {
  /** True when the operation changed packages on disk, not when it failed. */
  changed: boolean
  piStatus: 'stopped' | 'starting' | 'running' | 'error'
}

/**
 * What the banner should offer, or `null` when there is nothing to say.
 */
export function packageRestartNeed(input: PackageRestartInput): PackageRestartNeed | null {
  if (!input.changed) return null
  if (input.piStatus === 'starting') return 'busy'
  // Nothing holds the old code, so the next start loads the change by itself.
  if (input.piStatus === 'stopped' || input.piStatus === 'error') return 'nothingRunning'
  return 'restart'
}
