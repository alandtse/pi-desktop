import type { QueuedPrompt, RemoteSessionRef } from '../../shared/ipc-contracts'

/**
 * Send queues are the store's QueuedPrompt lists, keyed per chat.
 *
 * A message the user sent while the agent was busy. The app holds it, not the
 * engine, so Pi and OMP queue the same way: the store sends the oldest one as
 * a normal prompt when the turn ends, and "Send now" pushes one into the
 * running turn. The raw text and files are kept, so Edit can put them back in
 * the composer exactly as typed.
 */
export type { QueuedPrompt }

/**
 * Queued prompts per CHAT, oldest first.
 *
 * Keyed by chat rather than by project: two sessions in one project are two
 * conversations, and a queue keyed on the project could drain into whichever of
 * them happened to be on screen.
 */
export type SendQueues = Readonly<Record<string, readonly QueuedPrompt[]>>

/**
 * The key a chat's queue is stored under.
 *
 * A local chat is identified by its session file, which is what lets a queued
 * message survive a restart. Before the file exists the runtime id is used; that
 * key is not stable across restarts, but neither is the chat it belongs to.
 */
export function localQueueKey(sessionPath: string | null, runtimeId: string | null): string {
  if (sessionPath) return `local:${sessionPath}`
  return runtimeId ? `local-rt:${runtimeId}` : 'local-rt:unknown'
}

/** A remote chat is identified by the pair the relay routes on. */
export function remoteQueueKey(ref: RemoteSessionRef): string {
  return `remote:${ref.peer}:${ref.roomId}`
}

export function withQueued(queues: SendQueues, key: string, prompt: QueuedPrompt): SendQueues {
  return { ...queues, [key]: [...(queues[key] ?? []), prompt] }
}

/** The queues without that prompt. A queue left empty is dropped; the same queues come back when nothing changed. */
export function withoutQueued(queues: SendQueues, key: string, promptId: string): SendQueues {
  const queue = queues[key]
  if (!queue?.some((prompt) => prompt.id === promptId)) return queues
  const rest = queue.filter((prompt) => prompt.id !== promptId)
  const next = { ...queues }
  if (rest.length > 0) next[key] = rest
  else delete next[key]
  return next
}

/** The queues without that chat's queue (the chat was closed). */
export function withoutQueue(queues: SendQueues, key: string): SendQueues {
  if (!(key in queues)) return queues
  const next = { ...queues }
  delete next[key]
  return next
}

export function firstQueued(queues: SendQueues, key: string | null): QueuedPrompt | undefined {
  if (!key) return undefined
  return queues[key]?.[0]
}

/**
 * Drops entries for chats this run cannot reach, so a queue restored from disk
 * cannot accumulate forever behind a session that was deleted or a remote chat
 * its Pi no longer offers.
 */
export function pruneQueues(queues: SendQueues, knownKeys: ReadonlySet<string>): SendQueues {
  const next: Record<string, readonly QueuedPrompt[]> = {}
  let changed = false
  for (const key of Object.keys(queues)) {
    if (knownKeys.has(key)) next[key] = queues[key]
    else changed = true
  }
  return changed ? next : queues
}
