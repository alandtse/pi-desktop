// Regression tests for the continuation prompt and the chat identity it needs.
//
// The bug these guard: a session created moments after start received a
// "Please continue from where you stopped" that belonged to the session it
// replaced, because the send was gated on the WORKSPACE rather than on the chat.
//
// A full `openLastSession` run cannot be driven here: the continuation path
// deliberately waits on `pendingLastSessionOpen` and on a resumed session
// reporting its model, and the stubbed runtime never reports one, so the send is
// never reached and the test would pass with the fix reverted. These tests
// therefore pin the two decisions the path is made of, both of which the fix
// introduced.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_SETTINGS } from '../../shared/default-settings'
import { continuationPrompt } from '../../shared/interrupted-turn'
import { isSameSessionShown, useAppStore } from './store'

type StoreState = ReturnType<typeof useAppStore.getState>
type SessionState = StoreState['sessionState']

const WORKSPACE = {
  id: 'project',
  name: 'Project',
  path: '/project',
  createdAt: 0,
  lastOpenedAt: 0,
} as unknown as StoreState['workspaces'][number]

function stateWith(overrides: Partial<StoreState>): StoreState {
  return {
    ...useAppStore.getState(),
    workspaces: [WORKSPACE],
    activeWorkspace: WORKSPACE,
    settings: { ...DEFAULT_SETTINGS },
    ...overrides,
  } as StoreState
}

function sessionStateFor(sessionFile: string | null): SessionState {
  if (sessionFile === null) return null
  return {
    sessionFile,
    model: { provider: 'ollama-cloud', id: 'deepseek-v4.1-flash', name: 'Deepseek' },
  } as unknown as SessionState
}

test('a chat is identified by its session, not by the workspace it shares', () => {
  // Two sessions in one workspace are two chats, so the session on screen is the
  // only thing that may receive the prompt. Reverting the check to a workspace
  // comparison makes both assertions below true and this test fails.
  const shown = stateWith({ sessionState: sessionStateFor('/sessions/b.jsonl') })
  assert.equal(isSameSessionShown(shown, '/sessions/a.jsonl', 'project'), false)
  assert.equal(isSameSessionShown(shown, '/sessions/b.jsonl', 'project'), true)
})

test('a session that has not loaded yet is not the chat a prompt was meant for', () => {
  // A start replaces sessionState before the runtime reports the file it loaded,
  // so acting on that moment types into whatever ends up on screen.
  assert.equal(isSameSessionShown(stateWith({ sessionState: null }), '/sessions/a.jsonl', 'project'), false)
  const elsewhere = stateWith({ sessionState: sessionStateFor('/sessions/a.jsonl'), activeWorkspace: { ...WORKSPACE, id: 'other' } })
  assert.equal(isSameSessionShown(elsewhere, '/sessions/a.jsonl', 'project'), false)
})

test('an interrupted turn asks for a continuation and a finished one does not', () => {
  // The gate that decides whether anything is sent at all.
  // The shipped default, which is what the app actually sends.
  const base = { enabled: true, prompt: DEFAULT_SETTINGS.resumeInterruptedTurnPrompt, alreadyHandled: false }
  assert.match(String(continuationPrompt({ ...base, reason: 'tool-call-unanswered' })), /continue/i)
  assert.equal(continuationPrompt({ ...base, reason: null }), null)
  // Each interrupted reason the classifier can report offers a continuation.
  assert.ok(continuationPrompt({ ...base, reason: 'no-reply' }))
  assert.ok(continuationPrompt({ ...base, reason: 'errored' }))
  // A turn the user stopped classifies as null, and offers nothing.
  assert.equal(continuationPrompt({ ...base, reason: null }), null)
  assert.equal(continuationPrompt({ ...base, reason: 'tool-call-unanswered', enabled: false }), null)
})
