import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ID_CHARS, MAX_PROMPT_CHARS, parseClientMessage, type RemoteClientMessage } from './remote-protocol'

const VALID_MESSAGES: RemoteClientMessage[] = [
  { type: 'auth', token: 'abc' },
  { type: 'list_runtimes' },
  { type: 'list_sessions', workspaceId: 'ws-1' },
  { type: 'open_session', workspaceId: 'ws-1', sessionPath: '/home/u/.pi/agent/sessions/a.jsonl' },
  { type: 'new_session', workspaceId: 'ws-1' },
  { type: 'subscribe', runtimeId: 'rt-1' },
  { type: 'unsubscribe', runtimeId: 'rt-1' },
  { type: 'prompt', runtimeId: 'rt-1', text: 'hello' },
  { type: 'steer', runtimeId: 'rt-1', text: 'use tabs' },
  { type: 'abort', runtimeId: 'rt-1' },
  { type: 'dialog_response', dialogId: 'd-1', response: { kind: 'confirm', confirmed: true } },
  { type: 'dialog_response', dialogId: 'd-1', response: { kind: 'select', value: 'Allow' } },
  { type: 'dialog_response', dialogId: 'd-1', response: { kind: 'select', value: null } },
  { type: 'dialog_response', dialogId: 'd-1', response: { kind: 'input', value: 'text' } },
  { type: 'dialog_response', dialogId: 'd-1', response: { kind: 'input', value: null } },
]

for (const message of VALID_MESSAGES) {
  test(`accepts a valid ${message.type} message (${JSON.stringify(message).slice(0, 60)})`, () => {
    assert.deepEqual(parseClientMessage(JSON.stringify(message)), message)
  })
}

test('drops fields that are not part of the message', () => {
  const parsed = parseClientMessage(JSON.stringify({ type: 'abort', runtimeId: 'rt-1', admin: true, __proto__: { x: 1 } }))
  assert.deepEqual(parsed, { type: 'abort', runtimeId: 'rt-1' })
})

test('rejects text that is not JSON', () => {
  assert.equal(parseClientMessage('not json'), null)
  assert.equal(parseClientMessage(''), null)
})

test('rejects JSON that is not an object', () => {
  for (const raw of ['null', '1', '"abort"', 'true', '[]', '[{"type":"abort","runtimeId":"rt-1"}]']) {
    assert.equal(parseClientMessage(raw), null, raw)
  }
})

test('rejects an unknown or missing type', () => {
  assert.equal(parseClientMessage(JSON.stringify({ type: 'set_permission_mode', mode: 'trusted' })), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'constructor' })), null)
  assert.equal(parseClientMessage(JSON.stringify({ runtimeId: 'rt-1' })), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 7 })), null)
})

test('rejects a missing field and a field of the wrong type', () => {
  assert.equal(parseClientMessage(JSON.stringify({ type: 'abort' })), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'abort', runtimeId: 5 })), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'prompt', runtimeId: 'rt-1' })), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'prompt', runtimeId: 'rt-1', text: ['a'] })), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'open_session', workspaceId: 'ws-1' })), null)
})

test('rejects an empty id and an id over the limit', () => {
  assert.equal(parseClientMessage(JSON.stringify({ type: 'abort', runtimeId: '' })), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'abort', runtimeId: 'x'.repeat(MAX_ID_CHARS + 1) })), null)
  assert.notEqual(parseClientMessage(JSON.stringify({ type: 'abort', runtimeId: 'x'.repeat(MAX_ID_CHARS) })), null)
})

test('rejects an empty, blank or oversized prompt and steer text', () => {
  for (const type of ['prompt', 'steer'] as const) {
    assert.equal(parseClientMessage(JSON.stringify({ type, runtimeId: 'rt-1', text: '' })), null)
    assert.equal(parseClientMessage(JSON.stringify({ type, runtimeId: 'rt-1', text: '   \n' })), null)
    assert.equal(parseClientMessage(JSON.stringify({ type, runtimeId: 'rt-1', text: 'x'.repeat(MAX_PROMPT_CHARS + 1) })), null)
    assert.notEqual(parseClientMessage(JSON.stringify({ type, runtimeId: 'rt-1', text: 'x'.repeat(MAX_PROMPT_CHARS) })), null)
  }
})

test('rejects a dialog response of an unknown kind or a wrong value type', () => {
  const base = { type: 'dialog_response', dialogId: 'd-1' }
  assert.equal(parseClientMessage(JSON.stringify({ ...base })), null)
  assert.equal(parseClientMessage(JSON.stringify({ ...base, response: 'yes' })), null)
  assert.equal(parseClientMessage(JSON.stringify({ ...base, response: { kind: 'editor', value: 'x' } })), null)
  assert.equal(parseClientMessage(JSON.stringify({ ...base, response: { kind: 'confirm', confirmed: 'true' } })), null)
  assert.equal(parseClientMessage(JSON.stringify({ ...base, response: { kind: 'select', value: 3 } })), null)
  assert.equal(parseClientMessage(JSON.stringify({ ...base, response: { kind: 'input' } })), null)
})

test('drops extra fields inside a dialog response', () => {
  const parsed = parseClientMessage(
    JSON.stringify({ type: 'dialog_response', dialogId: 'd-1', response: { kind: 'confirm', confirmed: false, extra: 1 } }),
  )
  assert.deepEqual(parsed, { type: 'dialog_response', dialogId: 'd-1', response: { kind: 'confirm', confirmed: false } })
})
