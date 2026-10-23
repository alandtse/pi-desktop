import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  firstQueued,
  localQueueKey,
  pruneQueues,
  remoteQueueKey,
  withQueued,
  withoutQueue,
  withoutQueued,
  type QueuedPrompt,
  type SendQueues,
} from './send-queue'

const CHAT = localQueueKey('/sessions/chat-a.jsonl', null)
const OTHER_CHAT = localQueueKey('/sessions/chat-b.jsonl', null)

function prompt(id: string, text = `Message ${id}`): QueuedPrompt {
  return { id, text, attachments: [] }
}

test('withQueued appends to the end of one chat queue only', () => {
  let queues: SendQueues = {}
  queues = withQueued(queues, CHAT, prompt('a'))
  queues = withQueued(queues, CHAT, prompt('b'))
  queues = withQueued(queues, OTHER_CHAT, prompt('c'))
  assert.deepEqual(queues[CHAT].map((p) => p.id), ['a', 'b'])
  assert.deepEqual(queues[OTHER_CHAT].map((p) => p.id), ['c'])
})

test('firstQueued gives the oldest prompt, or nothing for an empty queue', () => {
  const queues = withQueued(withQueued({}, CHAT, prompt('a')), CHAT, prompt('b'))
  assert.equal(firstQueued(queues, CHAT)?.id, 'a')
  assert.equal(firstQueued(queues, OTHER_CHAT), undefined)
})

test('withoutQueued removes one prompt and drops a queue left empty', () => {
  const queues = withQueued(withQueued({}, CHAT, prompt('a')), CHAT, prompt('b'))
  const afterOne = withoutQueued(queues, CHAT, 'a')
  assert.deepEqual(afterOne[CHAT].map((p) => p.id), ['b'])
  const afterBoth = withoutQueued(afterOne, CHAT, 'b')
  assert.equal(CHAT in afterBoth, false)
})

test('withoutQueued returns the same queues when the prompt is not there', () => {
  const queues = withQueued({}, CHAT, prompt('a'))
  assert.equal(withoutQueued(queues, CHAT, 'missing'), queues)
  assert.equal(withoutQueued(queues, OTHER_CHAT, 'a'), queues)
})

test('withoutQueue drops one chat queue and keeps the others', () => {
  const queues = withQueued(withQueued({}, CHAT, prompt('a')), OTHER_CHAT, prompt('b'))
  const next = withoutQueue(queues, CHAT)
  assert.equal(CHAT in next, false)
  assert.deepEqual(next[OTHER_CHAT].map((p) => p.id), ['b'])
  assert.equal(withoutQueue(next, CHAT), next)
})

test('a local chat is keyed by its session file so the queue survives a restart', () => {
  assert.equal(localQueueKey('/sessions/a.jsonl', 'runtime-1'), localQueueKey('/sessions/a.jsonl', 'runtime-2'))
  assert.notEqual(localQueueKey('/sessions/a.jsonl', null), localQueueKey('/sessions/b.jsonl', null))
})

test('before a session file exists the runtime keys the queue', () => {
  assert.equal(localQueueKey(null, 'runtime-1'), 'local-rt:runtime-1')
  assert.equal(localQueueKey(null, null), 'local-rt:unknown')
})

test('a remote chat is keyed by the pair the relay routes on', () => {
  const ref = { peer: 'peer-a', roomId: 'room-1' }
  assert.equal(remoteQueueKey(ref), 'remote:peer-a:room-1')
  assert.notEqual(remoteQueueKey(ref), remoteQueueKey({ peer: 'peer-a', roomId: 'room-2' }))
})

test('pruneQueues drops queues whose chat this run cannot reach', () => {
  const queues = withQueued(withQueued({}, CHAT, prompt('a')), OTHER_CHAT, prompt('b'))
  const kept = pruneQueues(queues, new Set([CHAT]))
  assert.equal(CHAT in kept, true)
  assert.equal(OTHER_CHAT in kept, false)
  assert.equal(pruneQueues(kept, new Set([CHAT])), kept)
})

test('the queue functions never change the queues they were given', () => {
  const queues = withQueued({}, CHAT, prompt('a'))
  const snapshot = JSON.stringify(queues)
  withQueued(queues, CHAT, prompt('b'))
  withoutQueued(queues, CHAT, 'a')
  assert.equal(JSON.stringify(queues), snapshot)
})
