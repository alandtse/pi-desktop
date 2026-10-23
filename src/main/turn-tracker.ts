/**
 * Tracks which chats are mid-turn, and keeps that on disk as it changes.
 *
 * Persisting continuously rather than only on quit is deliberate: a quit is the
 * one moment least likely to run. Restarting via a forced kill, a crash, or a
 * deploy script that terminates the process all skip the quit hooks entirely, and
 * those are exactly the cases a continuation is meant to recover from. Writing
 * when the state changes means the record on disk is accurate whether the app
 * exits cleanly or not.
 */
import type { PiRpcEvent } from '../shared/ipc-contracts'

/** One chat's live turn state. */
interface TurnState {
  /** Session file the manager is running, captured when the turn started. */
  sessionPath: string
  /** ISO timestamp of the most recent activity in the turn. */
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

export interface TurnTrackerOptions {
  /** Called whenever the record changes, with the chats currently working. */
  onChange?: (midTurn: Record<string, string>) => void
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

/**
 * How often activity inside a running turn refreshes the record.
 *
 * A turn boundary is written immediately, because that is the fact the record
 * exists for. Refreshing on every token would write thousands of times a minute
 * to convey one bit — "still working" — so it is throttled to comfortably under
 * the staleness window.
 */
export const RECORD_REFRESH_MS = 15 * 1000

export function createTurnTracker(
  now: () => number = Date.now,
  options: TurnTrackerOptions = {},
): TurnTracker {
  const active = new Map<string, TurnState>()
  let lastRefresh = 0

  const snapshot = (): Record<string, string> => {
    const cutoff = now() - STALE_TURN_MS
    const record: Record<string, string> = {}
    for (const [path, state] of active) {
      if (Date.parse(state.startedAt) < cutoff) continue
      record[path] = state.startedAt
    }
    return record
  }

  const announce = (): void => {
    lastRefresh = now()
    options.onChange?.(snapshot())
  }

  return {
    observe(event, sessionPath) {
      if (!sessionPath) return

      if (event.type === 'agent_start') {
        active.set(sessionPath, { sessionPath, startedAt: new Date(now()).toISOString() })
        // A turn beginning is the fact this record exists to carry: written at
        // once so a kill one second later still leaves an accurate record.
        announce()
        return
      }

      if (event.type === 'agent_end') {
        active.delete(sessionPath)
        // A finished turn must leave no trace, or a later start would offer to
        // continue a conversation that already completed.
        announce()
        return
      }

      // Activity inside a live turn keeps it from ageing out, but is written at
      // most once per interval.
      if (!active.has(sessionPath)) return
      active.set(sessionPath, { sessionPath, startedAt: new Date(now()).toISOString() })
      if (now() - lastRefresh >= RECORD_REFRESH_MS) announce()
    },

    midTurn() {
      return snapshot()
    },

    forget(sessionPath) {
      if (!sessionPath) return
      if (active.delete(sessionPath)) announce()
    },
  }
}
