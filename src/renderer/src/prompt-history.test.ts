import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROMPT_HISTORY_LIMIT, promptHistoryFrom } from './prompt-history'
import type { DisplayMessage } from './message-parsing'

const user = (content: string): DisplayMessage => ({ id: content, role: 'user', content, timestamp: 0 })
const assistant = (content: string): DisplayMessage => ({ id: content, role: 'assistant', content, timestamp: 0 })

test('recall lists the prompts typed in this chat', () => {
  const messages = [user('first prompt'), assistant('answer'), user('second prompt'), assistant('answer')]
  assert.deepEqual(promptHistoryFrom(messages), ['first prompt', 'second prompt'])
})

test('only turns the user typed are recallable', () => {
  const messages = [
    user('real prompt'),
    { id: 'sys', role: 'system', content: 'Could not send', timestamp: 0 } as DisplayMessage,
    { id: 'tool', role: 'toolResult', content: 'output', timestamp: 0 } as DisplayMessage,
  ]
  assert.deepEqual(promptHistoryFrom(messages), ['real prompt'])
})

test('consecutive duplicates collapse and blanks are ignored', () => {
  const messages = [user('again'), assistant('ok'), user('again'), user('   '), user('different')]
  assert.deepEqual(promptHistoryFrom(messages), ['again', 'different'])
})

test('the list keeps the most recent prompts when it overflows', () => {
  const messages = Array.from({ length: PROMPT_HISTORY_LIMIT + 5 }, (_, index) => user(`prompt ${index}`))
  const history = promptHistoryFrom(messages)
  assert.equal(history.length, PROMPT_HISTORY_LIMIT)
  assert.equal(history[0], 'prompt 5')
  assert.equal(history[history.length - 1], `prompt ${PROMPT_HISTORY_LIMIT + 4}`)
})

test('an empty chat has no recall', () => {
  assert.deepEqual(promptHistoryFrom([]), [])
})
