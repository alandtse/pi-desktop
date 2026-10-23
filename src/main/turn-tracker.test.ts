// The record a quit leaves behind must name exactly the chats that were working.
//
// A false positive sends a prompt nobody asked for; a false negative silently
// drops the continuation the feature exists to provide. Both are covered here.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { STALE_TURN_MS, createTurnTracker } from './turn-tracker'

const START = { type: 'agent_start' } as never
const END = { type: 'agent_end' } as never
const ACTIVITY = { type: 'message_start' } as never

test('a chat is remembered from the start of its turn until the turn ends', () => {
  const tracker = createTurnTracker(() => 1000)
  tracker.observe(START, '/sessions/a.jsonl')
  assert.deepEqual(Object.keys(tracker.midTurn()), ['/sessions/a.jsonl'])

  tracker.observe(END, '/sessions/a.jsonl')
  assert.deepEqual(tracker.midTurn(), {}, 'a finished turn is not mid-turn')
})

test('two chats working at once are both recorded', () => {
  // The bug this guards: a quit with several chats working must record all of
  // them, or whichever one is not restored silently loses its continuation.
  const tracker = createTurnTracker(() => 1000)
  tracker.observe(START, '/sessions/a.jsonl')
  tracker.observe(START, '/sessions/b.jsonl')
  assert.deepEqual(Object.keys(tracker.midTurn()).sort(), ['/sessions/a.jsonl', '/sessions/b.jsonl'])
})

test('a turn with activity is still mid-turn', () => {
  // A long tool call emits activity but no end; ageing it out would drop a chat
  // that is genuinely still working.
  let clock = 1000
  const tracker = createTurnTracker(() => clock)
  tracker.observe(START, '/sessions/a.jsonl')
  clock += STALE_TURN_MS / 2
  tracker.observe(ACTIVITY, '/sessions/a.jsonl')
  clock += STALE_TURN_MS / 2 + 1
  assert.deepEqual(Object.keys(tracker.midTurn()), ['/sessions/a.jsonl'])
})

test('a turn nothing has been heard from for too long is not recorded', () => {
  // A Pi killed without an `agent_end` would otherwise be offered for
  // continuation on every later start.
  let clock = 1000
  const tracker = createTurnTracker(() => clock)
  tracker.observe(START, '/sessions/a.jsonl')
  clock += STALE_TURN_MS * 2
  assert.deepEqual(tracker.midTurn(), {})
})

test('a manager that exits stops being mid-turn', () => {
  const tracker = createTurnTracker(() => 1000)
  tracker.observe(START, '/sessions/a.jsonl')
  tracker.forget('/sessions/a.jsonl')
  assert.deepEqual(tracker.midTurn(), {})
})

test('an event for a chat with no session file is ignored', () => {
  const tracker = createTurnTracker(() => 1000)
  tracker.observe(START, null)
  assert.deepEqual(tracker.midTurn(), {})
})
