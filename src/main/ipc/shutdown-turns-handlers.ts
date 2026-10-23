/**
 * The quit-time write and the startup read of the mid-turn record.
 *
 * Kept as IPC rather than module state because the renderer is what decides to
 * continue a chat: main records the fact on the way out, and the renderer asks
 * on the way in whether the chat it restored was genuinely working.
 */
import { app, ipcMain } from 'electron'

import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type { ShutdownTurns } from '../shutdown-turns'
import { clearShutdownTurns, readShutdownTurns, shouldContinueFromMarker, writeShutdownTurnsSync } from '../shutdown-turns'
import type { TurnTracker } from '../turn-tracker'
import { assertTrustedSender } from './validation'
import { getGuiDataDir } from '../app-data-paths'

/**
 * Writes the record a quit leaves behind, synchronously.
 *
 * Synchronous because the quit path cannot wait: the same handler stops the
 * managers, which ends their turns, so an async write would race the very state
 * it is recording. Failure is logged rather than thrown — a missing record only
 * means the next start continues nothing.
 */
export function recordMidTurnSync(turnTracker: TurnTracker): void {
  const record: ShutdownTurns = { recordedAt: new Date().toISOString(), midTurn: turnTracker.midTurn() }
  try {
    writeShutdownTurnsSync(getGuiDataDir(), record)
  } catch (error) {
    console.warn('[shutdown-turns] could not record the mid-turn chats', error)
  }
}

export function registerShutdownTurnsHandler(workspaceManager: unknown, _turnTracker: TurnTracker): void {
  // The renderer asks once per restored chat. Answered from the record a previous
  // run wrote, so "was this interrupted?" stops being a guess about a file's last
  // record and becomes a fact the closing app observed.
  ipcMain.handle(IPC_CHANNELS.SESSION_WAS_MID_TURN_AT_SHUTDOWN, async (event, sessionPath: unknown) => {
    assertTrustedSender(event)
    if (typeof sessionPath !== 'string' || !sessionPath) return false
    const record = await readShutdownTurns(getGuiDataDir())
    return shouldContinueFromMarker(record, sessionPath)
  })

  // Cleared after the renderer has had its answer, so a record cannot outlive the
  // start it belongs to and offer a stale continuation on the start after that.
  ipcMain.handle(IPC_CHANNELS.SESSION_CLEAR_SHUTDOWN_MARKER, async (event) => {
    assertTrustedSender(event)
    await clearShutdownTurns(getGuiDataDir())
  })
  void workspaceManager
  void app
}
