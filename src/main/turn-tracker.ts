/**
 * Tracks which chats are mid-turn, and keeps that on disk as it changes.
 *
 * Persisting continuously rather than only on quit is deliberate: a quit is the
 * one moment least likely to run. Restarting via a forced kill, a crash, a
 * power loss, or a deploy script that terminates the process all skip the quit
 * hooks entirely, and those are exactly the cases a continuation is meant to
 * recover from. Writing when the state changes means the record on disk is
 * accurate whether the app exits cleanly or not.
 *
 * Each claim carries the run that wrote it, so a later run can tell "this was
 * interrupted" from "this is still running".
 */
import type { PiRpcEvent } from '../shared/ipc-contracts'
import type { TurnClaim } from './shutdown-turns'

/** What one chat's live turn looks like while it is running. */
interface TurnState {
  /** ISO timestamp of the turn's first event. */
  startedAt: string
  /** ISO timestamp of the most recent activity seen in it. */
  lastSeenAt: string
}

export interface TurnTracker {
  /** Feed one manager event. `sessionPath` resolves the manager's session, if any. */
  observe(event: PiRpcEvent, sessionPath: string | null): void
  /** Chats with a turn open right now, keyed by session file. */
  midTurn(): Record<string, TurnClaim>
  /** Forget one manager's chats, e.g. when its process exits. */
  forget(sessionPath: string | null): void
}

export interface TurnTrackerOptions {
  /** Called whenever the record changes, with the chats currently working. */
  onChange?: (midTurn: Record<string, TurnClaim>) => void
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
  runId: string,
  now: () => number = Date.now,
  options: TurnTrackerOptions = {},
  pid: number = process.pid,
): TurnTracker {
  const active = new Map<string, TurnState>()
  let lastRefresh = 0

  const snapshot = (): Record<string, TurnClaim> => {
    const cutoff = now() - STALE_TURN_MS
    const record: Record<string, TurnClaim> = {}
    for (const [path, state] of active) {
      // Ageing out on the LAST activity, not the turn's start: a long agent run
      // emits events throughout, and measuring from the start would drop a
      // fifteen-minute turn while it was still working.
      if (Date.parse(state.lastSeenAt) < cutoff) continue
      record[path] = { runId, pid, startedAt: state.startedAt, lastSeenAt: state.lastSeenAt }
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
        const at = new Date(now()).toISOString()
        active.set(sessionPath, { startedAt: at, lastSeenAt: at })
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
      const state = active.get(sessionPath)
      if (!state) return
      state.lastSeenAt = new Date(now()).toISOString()
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
