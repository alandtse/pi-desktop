import { powerSaveBlocker } from 'electron'
import { spawn } from 'child_process'
import type { KeepAwakeStatus } from '../shared/ipc-contracts'
import { PI_DESKTOP_PRODUCT_NAME } from '../shared/product-name'
import { createKeepAwake } from './keep-awake'
import { createSystemInhibitor } from './keep-awake-system-inhibitor'
import { createKeepAwakeCoordinator } from './keep-awake-coordinator'
import { dbusNameHasOwner } from './dbus-probe'
import { appLog } from './app-log'

const LOG_SCOPE = 'power'

/** Shown by `systemd-inhibit --list` next to the lock. */
const INHIBITOR_REASON = 'Keep this computer awake is turned on'

/**
 * The session-bus services Electron's blocker asks on Linux. With neither
 * present (sway, i3, Hyprland and other bare window managers) the blocker
 * does nothing and reports no error.
 */
const DESKTOP_SLEEP_SERVICES = ['org.gnome.SessionManager', 'org.freedesktop.PowerManagement']

const STATUS_LOG_MESSAGES: Record<KeepAwakeStatus, string> = {
  off: 'Keep awake turned off',
  active: 'Keep awake turned on',
  unsupported: 'Keep awake is on, but this system has no service that can block sleep',
}

const systemInhibitor = createSystemInhibitor({
  // stdin stays an open pipe: the helper holds the lock until that pipe closes.
  spawn: (command, args) => spawn(command, [...args], { stdio: ['pipe', 'ignore', 'ignore'] }),
  who: PI_DESKTOP_PRODUCT_NAME,
  why: INHIBITOR_REASON,
  onLost: () => {
    coordinator.handleSystemInhibitorLost()
    appLog.warn(LOG_SCOPE, 'The system sleep lock ended unexpectedly')
  },
})

const coordinator = createKeepAwakeCoordinator({
  platform: process.platform,
  desktopBlocker: createKeepAwake(powerSaveBlocker),
  systemInhibitor,
  hasDesktopSleepService: async () =>
    (await Promise.all(DESKTOP_SLEEP_SERVICES.map(dbusNameHasOwner))).some(Boolean),
})

/** Match the sleep block to the user's setting. Safe to call on every save. */
export async function applyKeepAwake(enabled: boolean): Promise<void> {
  const before = coordinator.getStatus()
  const status = await coordinator.apply(enabled)
  if (status === before) return
  if (status === 'unsupported') appLog.warn(LOG_SCOPE, STATUS_LOG_MESSAGES[status])
  else appLog.info(LOG_SCOPE, STATUS_LOG_MESSAGES[status])
}

export function getKeepAwakeStatus(): KeepAwakeStatus {
  return coordinator.getStatus()
}
