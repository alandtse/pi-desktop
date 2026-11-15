import type { KeepAwakeStatus } from '../shared/ipc-contracts'
import type { KeepAwake } from './keep-awake'
import type { SystemInhibitor } from './keep-awake-system-inhibitor'

export interface KeepAwakeCoordinatorDeps {
  platform: NodeJS.Platform
  /** Electron's blocker: the native API on macOS and Windows, a desktop D-Bus service on Linux. */
  desktopBlocker: KeepAwake
  /** The systemd-logind lock, used on Linux when the desktop has no sleep service. */
  systemInhibitor: SystemInhibitor
  /**
   * Linux only. Electron's blocker does nothing, and reports no error, when
   * the desktop has no sleep service, so its presence must be checked here.
   */
  hasDesktopSleepService(): Promise<boolean>
}

export interface KeepAwakeCoordinator {
  apply(enabled: boolean): Promise<KeepAwakeStatus>
  getStatus(): KeepAwakeStatus
  handleSystemInhibitorLost(): void
}

/**
 * Picks the layer that can keep this system awake. The desktop blocker is
 * preferred because it leaves a manual Sleep command working; the system
 * inhibitor is the fallback for Linux desktops without a power manager.
 */
export function createKeepAwakeCoordinator(deps: KeepAwakeCoordinatorDeps): KeepAwakeCoordinator {
  let status: KeepAwakeStatus = 'off'
  // Saves can arrive faster than a lock is taken; running them in order makes the last one win.
  let queue: Promise<unknown> = Promise.resolve()

  const turnOn = async (): Promise<KeepAwakeStatus> => {
    deps.desktopBlocker.apply(true)
    if (deps.platform !== 'linux') return 'active'
    if (await deps.hasDesktopSleepService()) {
      deps.systemInhibitor.release()
      return 'active'
    }
    return (await deps.systemInhibitor.acquire()) ? 'active' : 'unsupported'
  }

  const turnOff = (): KeepAwakeStatus => {
    deps.desktopBlocker.apply(false)
    deps.systemInhibitor.release()
    return 'off'
  }

  return {
    getStatus: () => status,

    apply(enabled) {
      const run = queue.then(async () => {
        status = enabled ? await turnOn() : turnOff()
        return status
      })
      queue = run.catch(() => undefined)
      return run
    },

    handleSystemInhibitorLost() {
      if (status === 'active') status = 'unsupported'
    },
  }
}
