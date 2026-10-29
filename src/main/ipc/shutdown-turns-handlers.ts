/**
 * The live write, the quit write, and the startup read of the mid-turn record.
 *
 * Kept as IPC rather than module state because the renderer is what decides to
 * continue a chat: main records the facts, and the renderer asks on the way in
 * whether the chat it restored was genuinely working when the last run stopped.
 */
import { ipcMain } from 'electron'

import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { claimFor, readShutdownTurns, writeShutdownTurnsSync } from '../shutdown-turns'
import type { ShutdownTurns } from '../shutdown-turns'
import type { TurnTracker } from '../turn-tracker'
import { assertTrustedSender } from './validation'
import { getGuiDataDir } from '../app-data-paths'
import { appLog } from '../app-log'

/**
 * Writes the record as the live state changes, synchronously.
 *
 * Synchronous because the quit path cannot wait: the same handler stops the Pi
 * managers, which ends their turns, so an async write would race the very state
 * it is recording. Failure is logged rather than thrown — a missing record only
 * means the next start continues nothing.
 */
export function recordMidTurnSync(turnTracker: TurnTracker, runId: string, cleanExit = false): void {
  const midTurn = turnTracker.midTurn()
  const record: ShutdownTurns = {
    runId,
    recordedAt: new Date().toISOString(),
    cleanExit,
    midTurn,
  }
  const count = Object.keys(midTurn).length
  try {
    writeShutdownTurnsSync(getGuiDataDir(), record)
    appLog.info(
      'continue',
      cleanExit ? `Clean exit with ${count} chat(s) still mid-turn` : `Recorded ${count} chat(s) still working`,
    )
  } catch (error) {
    appLog.warn('continue', 'Could not record the mid-turn chats', error)
  }
}

export interface ShutdownTurnsOptions {
  /** This run's identity, so a claim this run wrote is never offered back to it. */
  runId: string
}

export function registerShutdownTurnsHandler(
  _workspaceManager: unknown,
  _turnTracker: TurnTracker,
  options: ShutdownTurnsOptions,
): void {
  // The renderer asks once per restored chat. Answered from the record the
  // previous run wrote, so "was this interrupted?" stops being a guess about a
  // file's last record and becomes a fact a run observed about itself.
  ipcMain.handle(
    IPC_CHANNELS.SESSION_WAS_MID_TURN_AT_SHUTDOWN,
    async (event, sessionPath: unknown) => {
      assertTrustedSender(event)
      if (typeof sessionPath !== 'string' || !sessionPath) return false
      const record = await readShutdownTurns(getGuiDataDir())
      return claimFor(record, sessionPath, options.runId) !== null
    },
  )

  // Every chat a previous run left working, so a start can reopen them all.
  // Continuation used to be offered only to the chat the app restored, so a quit
  // with three chats working continued at most one and nothing ever asked about
  // the others.
  ipcMain.handle(IPC_CHANNELS.SESSION_INTERRUPTED_CHATS, async (event) => {
    assertTrustedSender(event)
    const record = await readShutdownTurns(getGuiDataDir())
    if (!record) return []
    return Object.keys(record.midTurn).filter((sessionPath) =>
      claimFor(record, sessionPath, options.runId) !== null,
    )
  })

  // Consumes ONE chat's claim. It used to clear the whole file, which meant the
  // first chat restored took the record and every other interrupted chat was
  // told it had not been interrupted. Rewriting the record with one entry
  // removed keeps the rest for their own asks, which come one after another
  // because the renderer restores chats sequentially.
  ipcMain.handle(
    IPC_CHANNELS.SESSION_CLEAR_SHUTDOWN_MARKER,
    async (event, sessionPath: unknown) => {
      assertTrustedSender(event)
      const record = await readShutdownTurns(getGuiDataDir())
      if (!record) return
      if (typeof sessionPath !== 'string' || !sessionPath) {
        // No path means "drop the whole record" — kept for callers that are
        // deliberately abandoning everything.
        writeShutdownTurnsSync(getGuiDataDir(), { ...record, midTurn: {} })
        return
      }
      if (!(sessionPath in record.midTurn)) return
      const { [sessionPath]: _dropped, ...rest } = record.midTurn
      writeShutdownTurnsSync(getGuiDataDir(), { ...record, midTurn: rest })
    },
  )
}
