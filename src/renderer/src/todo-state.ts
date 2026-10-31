/**
 * Reading a task list out of a session.
 *
 * `rpiv-todo` — the todo tool agents actually reach for — persists its whole state
 * twice per change, both times as data the app already receives:
 *
 *  - a `custom` branch entry with `customType: "rpiv-todo-state"` whose `data` is the
 *    full snapshot (`{ tasks, nextId }`). Written by `pi.appendEntry(...)` from
 *    `@juicesharp/rpiv-todo/todo.ts:91` for EVERY state-changing call, and pi streams
 *    it as `{ type: "entry_appended", entry }` (`agent-session.js:2784`).
 *  - the tool result's `details`, which carry the same `{ tasks, nextId }` envelope.
 *
 * The app rendered neither, so a task list an agent was working from was invisible
 * in the GUI. This module is the reading side: last-write-wins on the state entries,
 * falling back to tool results for sessions written before entries existed — the
 * same precedence `@juicesharp/rpiv-todo/state/replay.ts:62` uses, so the panel and
 * the agent's own view of its list cannot disagree.
 */

/** The branch-entry type `rpiv-todo` writes. Mirrors `STATE_ENTRY_TYPE` in rpiv-todo. */
export const TODO_STATE_ENTRY_TYPE = 'rpiv-todo-state'

/** The tool whose results carry a task snapshot as `details`. */
export const TODO_TOOL_NAME = 'todo'

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

export interface TodoTask {
  id: number
  subject: string
  status: TaskStatus
  description?: string
  activeForm?: string
  owner?: string
}

export interface TodoSnapshot {
  tasks: TodoTask[]
  nextId: number
  /**
   * When this snapshot was recorded, in epoch ms, when the source could tell.
   *
   * Every branch entry pi streams carries a timestamp, so the list the app shows
   * knows when each state change happened even though rpiv-todo stores only the
   * tasks themselves. Optional because a payload read from a tool result on an
   * older session may arrive without one.
   */
  updatedAt?: number
  /**
   * True when this came from a `rpiv-todo-state` branch entry. Entries are written for
   * every state change, so once one is seen a tool result cannot add anything — it can
   * only repeat or predate it. Without this flag a reload would freeze on the first
   * tool result it read and never advance.
   */
  fromEntry?: boolean
}

/** The status marker `rpiv-todo` uses for a task that is being worked on. */
export const ACTIVE_STATUS: TaskStatus = 'in_progress'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStatus(value: unknown): value is TaskStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'deleted'
}

function isTask(value: unknown): value is TodoTask {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'number' &&
    typeof value.subject === 'string' &&
    isStatus(value.status)
  )
}

/**
 * Read a snapshot out of an unknown payload.
 *
 * The shape is checked rather than trusted: this data is replayed from a session
 * file that an older or newer extension version may have written, and a malformed
 * task list must not take the panel down with it.
 */
export function readTodoSnapshot(value: unknown): TodoSnapshot | null {
  if (!isRecord(value)) return null
  const tasks = value.tasks
  if (!Array.isArray(tasks)) return null
  const nextId = typeof value.nextId === 'number' && Number.isSafeInteger(value.nextId) ? value.nextId : 0
  return {
    tasks: tasks.filter(isTask).map((task) => ({ ...task })),
    nextId,
  }
}

/** A branch entry as far as this module cares — the two shapes it may arrive in. */
export interface TodoSourceEntry {
  type?: string
  customType?: string
  data?: unknown
  /** Epoch ms written by pi on every branch entry; the only clock this list has. */
  timestamp?: number
  message?: {
    role?: string
    toolName?: string
    details?: unknown
    /** Pi stamps each message too, so a tool result can date its own snapshot. */
    timestamp?: number
  }
}

/**
 * Fold one event into the running snapshot, returning the new one or `null` when the
 * event says nothing about tasks.
 *
 * Accepts every shape the stream can produce so the caller does not have to care:
 * a live `entry_appended` event, a replayed `custom` entry, or a `toolResult` whose
 * `details` carry the envelope. Deletions are honoured because `rpiv-todo` marks a
 * task `deleted` rather than removing it — showing it would contradict the agent.
 */
/**
 * The moment a snapshot was recorded, when the source carries one.
 *
 * Timestamps arrive as epoch ms from pi, but a hand-edited or older session can hold
 * an ISO string; both are worth dating the list with, and anything else is ignored so
 * the panel shows no time rather than an invented one.
 */
function readTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

export function foldTodoEvent(previous: TodoSnapshot | null, entry: TodoSourceEntry): TodoSnapshot | null {
  if (entry.type === 'entry_appended') {
    const appended = (entry as { entry?: TodoSourceEntry }).entry
    if (appended?.customType !== TODO_STATE_ENTRY_TYPE) return null
    const snapshot = readTodoSnapshot(appended.data)
    const updatedAt = readTimestamp(appended.timestamp)
    return snapshot ? { ...snapshot, fromEntry: true, ...(updatedAt !== undefined ? { updatedAt } : {}) } : null
  }

  if (entry.type === 'custom' && entry.customType === TODO_STATE_ENTRY_TYPE) {
    const snapshot = readTodoSnapshot(entry.data)
    const updatedAt = readTimestamp(entry.timestamp)
    return snapshot ? { ...snapshot, fromEntry: true, ...(updatedAt !== undefined ? { updatedAt } : {}) } : null
  }

  if (entry.message?.role === 'toolResult' && entry.message.toolName === TODO_TOOL_NAME) {
    const snapshot = readTodoSnapshot(entry.message.details)
    // Only a state-changing call writes a snapshot; a `list` call must not blank the
    // panel, and an unreadable payload leaves what is already shown alone.
    if (snapshot === null) return null
    // An entry is authoritative; a tool result is the only source in a session written
    // before entries existed. Later tool results still win over earlier ones, which is
    // what makes a reload recover the final list rather than the first one.
    if (previous?.fromEntry) return null
    const updatedAt = readTimestamp(entry.message.timestamp)
    return updatedAt !== undefined ? { ...snapshot, updatedAt } : snapshot
  }

  return null
}

/** The tasks worth showing: everything the agent has not deleted. */
export function visibleTasks(snapshot: TodoSnapshot | null): TodoTask[] {
  if (!snapshot) return []
  return snapshot.tasks.filter((task) => task.status !== 'deleted')
}

/** How many tasks are still to do, the badge count. */
export function remainingCount(tasks: readonly TodoTask[]): number {
  return tasks.filter((task) => task.status === 'pending' || task.status === ACTIVE_STATUS).length
}

/**
 * Which task is in progress, if any.
 *
 * `rpiv-todo` allows one active task at a time; if a snapshot somehow carries more,
 * the newest wins so the panel shows something stable rather than flickering.
 */
export function activeTask(tasks: readonly TodoTask[]): TodoTask | null {
  const active = tasks.filter((task) => task.status === ACTIVE_STATUS)
  return active.length > 0 ? active[active.length - 1] : null
}

/** Task counts for the collapsed summary. */
export interface TodoCounts {
  total: number
  remaining: number
  done: number
}

export function todoCounts(tasks: readonly TodoTask[]): TodoCounts {
  const visible = tasks.filter((task) => task.status !== 'deleted')
  return {
    total: visible.length,
    remaining: remainingCount(visible),
    done: visible.filter((task) => task.status === 'completed').length,
  }
}

/**
 * Rebuild the task list from a transcript.
 *
 * The app used to lose the list on every tab switch, because a live switch only sends
 * `get_messages` and the snapshot arrives on the branch stream, which a switched-to
 * session never replays. A tool result does carry the same snapshot in `details`
 * (measured: 26 branch entries and 29 todo tool results in one real session), so the
 * list can be recovered from messages the app already receives.
 *
 * Messages older than the newest snapshot are folded in order and last write wins, the
 * same precedence `foldTodoEvent` uses for a live stream — so a reloaded session and a
 * live one cannot show different lists for the same history.
 */
export function todoFromMessages(messages: readonly { role: string; toolName?: string; toolDetails?: unknown; timestamp: number }[]): TodoSnapshot | null {
  let snapshot: TodoSnapshot | null = null
  for (const message of messages) {
    if (message.role !== 'toolResult' || message.toolName !== TODO_TOOL_NAME) continue
    snapshot = foldTodoEvent(snapshot, {
      message: { role: message.role, toolName: message.toolName, details: message.toolDetails, timestamp: message.timestamp },
    })
  }
  return snapshot
}
