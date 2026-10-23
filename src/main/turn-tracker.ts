/**
 * Tracks which chats are mid-turn right now, so a quit can record it.
 *
 * This is the live counterpart to `shutdown-turns.ts`: the router feeds every
 * manager's events here, and the quit path asks for a snapshot. It is separate
 * from the file-based check because the file cannot tell a turn the app's own
 * quit cut short from one the user simply stopped, while this can — it observes
 * the turn boundaries directly.
 */
import type { PiRpcEvent } from '../shared/ipc-contracts'

/** One chat's live turn state. */
interface TurnState {
  /** Session file the manager is running, captured when the turn started. */
  sessionPath: string
  /** ISO timestamp of the `agent_start` that opened the turn. */
  startedAt: string
}

export interface TurnTracker {
  /** Feed one manager event. `sessionPath` resolves the manager's session, if any. */
  observe(event: PiRpcEvent, sessionPath: string | null): void
  /** Chats with a turn open right now, keyed by session file. */
  midTurn(): Record<string, string>
  /** Forget one manager's chats, e.g. when its process exits. */
  forget(sessionPath: string | null): void
}

/**
 * A turn that has recorded no activity for longer than this is treated as gone.
 *
 * A Pi killed without emitting `agent_end` would otherwise leave its chat marked
 * mid-turn forever, and every later start would offer a continuation for a turn
 * that no longer exists. Ten minutes is far longer than any gap inside a live
 * turn on this machine and far shorter than a session left overnight.
 */
export const STALE_TURN_MS = 10 * 60 * 1000

export function createTurnTracker(now: () => number = Date.now): TurnTracker {
  const active = new Map<string, TurnState>()

  const forgetStale = (): void => {
    const cutoff = now() - STALE_TURN_MS
    for (const [path, state] of active) {
      if (Date.parse(state.startedAt) < cutoff) active.delete(path)
    }
  }

  return {
    observe(event, sessionPath) {
      if (!sessionPath) return
      if (event.type === 'agent_start') {
        active.set(sessionPath, { sessionPath, startedAt: new Date(now()).toISOString() })
        return
      }
      // Every other event from a live turn refreshes it, so a slow tool call does
      // not age a working chat out of the record.
      if (active.has(sessionPath)) {
        const entry = active.get(sessionPath)!
        active.set(sessionPath, { ...entry, startedAt: new Date(now()).toISOString() })
      }
      if (event.type === 'agent_end') active.delete(sessionPath)
    },

    midTurn() {
      forgetStale()
      const record: Record<string, string> = {}
      for (const [path, state] of active) record[path] = state.startedAt
      return record
    },

    forget(sessionPath) {
      if (sessionPath) active.delete(sessionPath)
    },
  }
}
