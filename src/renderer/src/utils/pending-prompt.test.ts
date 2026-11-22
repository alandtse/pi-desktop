import assert from 'node:assert/strict'
import test from 'node:test'
import type { PendingPromptItem, PiExtensionUiRequest } from '../../../shared/ipc-contracts'
import { isPendingPromptAlreadyOpen, pendingPromptResponse } from './pending-prompt'

const item: PendingPromptItem = {
  request: { type: 'extension_ui_request', id: 'prompt-1', method: 'confirm', title: 'Allow?' },
  workspaceId: 'workspace-1',
  runtimeId: 'runtime-1',
  sessionPath: '/project/.pi/sessions/session.jsonl',
  receivedAt: 10,
}

const activeRequest: PiExtensionUiRequest = {
  type: 'extension_ui_request',
  id: 'prompt-1',
  method: 'confirm',
  title: 'Allow?',
}

test('inbox marks only the matching local runtime dialog as already open', () => {
  assert.equal(isPendingPromptAlreadyOpen(item, activeRequest, 'runtime-1', {}), true)
  assert.equal(isPendingPromptAlreadyOpen(item, activeRequest, 'runtime-2', {}), false)
  assert.equal(isPendingPromptAlreadyOpen(item, activeRequest, 'runtime-1', { 'prompt-1': { peerId: 'peer' } }), false)
  assert.equal(isPendingPromptAlreadyOpen(item, null, 'runtime-1', {}), false)
})

test('prompt answers map only to explicit supported response shapes', () => {
  assert.deepEqual(pendingPromptResponse('confirm', { confirmed: true }), { kind: 'confirm', confirmed: true })
  assert.deepEqual(pendingPromptResponse('confirm', { confirmed: false }), { kind: 'confirm', confirmed: false })
  assert.deepEqual(pendingPromptResponse('select', { value: 'option' }), { kind: 'value', value: 'option' })
  assert.deepEqual(pendingPromptResponse('input', { value: 'text' }), { kind: 'value', value: 'text' })
  assert.deepEqual(pendingPromptResponse('editor', { value: 'text' }), { kind: 'value', value: 'text' })
  assert.equal(pendingPromptResponse('confirm', { value: 'yes' }), null)
  assert.equal(pendingPromptResponse('notify', { value: 'ignored' }), null)
  assert.equal(pendingPromptResponse('input', { confirmed: true }), null)
})
