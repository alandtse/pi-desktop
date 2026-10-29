import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PiRpcEvent } from '../../shared/ipc-contracts'
import { useAppStore } from './store'

beforeEach(() => {
  useAppStore.setState({ pendingInsert: null, currentView: 'chat' })
})

/**
 * A command that wants the user to read or edit text sends it back as
 * `set_editor_text`. The store used to drop that frame on the floor, so the
 * text a command produced never appeared anywhere.
 */
test('set_editor_text puts the command text in the composer', () => {
  const event = {
    type: 'extension_ui_request',
    id: 'report',
    method: 'set_editor_text',
    text: 'deepseek-v4.1-flash: no advice\n  no advertised cache lifetime',
  } as unknown as PiRpcEvent

  useAppStore.getState().handlePiEvent(event)

  const insert = useAppStore.getState().pendingInsert
  assert.equal(insert?.text, 'deepseek-v4.1-flash: no advice\n  no advertised cache lifetime')
  assert.equal(insert?.replace, true, 'the report replaces the composer rather than being appended to it')
})

test('set_editor_text with no text leaves the composer alone', () => {
  useAppStore.getState().handlePiEvent({
    type: 'extension_ui_request',
    id: 'empty',
    method: 'set_editor_text',
  } as unknown as PiRpcEvent)
  assert.equal(useAppStore.getState().pendingInsert, null)
})

test('setTitle is still fire-and-forget', () => {
  useAppStore.getState().handlePiEvent({
    type: 'extension_ui_request',
    id: 'title',
    method: 'setTitle',
    statusText: 'a title',
  } as unknown as PiRpcEvent)
  assert.equal(useAppStore.getState().pendingInsert, null)
})
