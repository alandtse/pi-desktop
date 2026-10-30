/**
 * Switching between chats that have already been loaded must reuse what was
 * loaded, not blank the chat and wait for the engine again.
 *
 * Every switch path clears the transcript before it knows what to show, then
 * paints from a cache keyed by session. Four combinations had no cache read on
 * them at all — a project activated while its runtime is stopped, a session tab
 * whose runtime is live, a remote room, and a remote room whose Pi has run a
 * turn since — so each of those showed a spinner for a conversation the
 * renderer was already holding.
 *
 * These tests drive the store through the public actions and assert the
 * transcript is on screen BEFORE the bridge has answered, which is the only
 * claim that matters: paint after the round trip is what the bug looked like.
 */
import { before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type {
  RemoteSessionRef,
  SessionListItem,
  SessionRuntimeInfo,
  Workspace,
} from '../../shared/ipc-contracts'
import type { DisplayMessage } from './message-parsing'

const WORKSPACE: Workspace = {
  id: 'one', name: 'One', path: '/tmp/one', color: '#000', createdAt: 0, lastActiveAt: 0,
}
const OTHER_WORKSPACE: Workspace = {
  ...WORKSPACE, id: 'two', name: 'Two', path: '/tmp/two',
}
const SESSION = '/home/user/.pi/agent/sessions/--tmp-one--/a.jsonl'
const OTHER_SESSION = '/home/user/.pi/agent/sessions/--tmp-one--/b.jsonl'
const REMOTE_REF: RemoteSessionRef = { peer: 'peer-key', roomId: 'room-abc', hostname: 'Studio' }

/** A gate whose release the test controls, so "before the answer" is testable. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
  return { wait, release }
}

let useAppStore: typeof import('./store')['useAppStore']
let switchGate = gate()
let messagesGate = gate()
let remoteGate = gate()
let lookupGate = gate()
let remoteRows: SessionListItem[] = []

/** The rows session.list answers with — kept in step with the seeded list. */
let listRows: SessionListItem[] = []

function transcript(text: string): DisplayMessage[] {
  return [{ id: `msg-${text}`, role: 'user', content: text, timestamp: 0 }]
}

function runtimeFor(sessionPath: string | null, status: SessionRuntimeInfo['status'] = 'running'): SessionRuntimeInfo {
  return {
    runtimeId: 'rt', workspaceId: WORKSPACE.id, sessionPath, sessionId: 'id', activity: null,
    active: true, status, pid: 1, error: null,
  }
}

before(async () => {
  Object.assign(globalThis, {
    window: {
      piDesktop: {
        session: {
          resumeTarget: async () => {
            await lookupGate.wait
            return SESSION
          },
          switch: async (path: string) => {
            await switchGate.wait
            return runtimeFor(path)
          },
          getState: async () => ({ success: true, data: { messageCount: 1 } }),
          getStats: async () => ({ success: true, data: null }),
          getMessages: async () => {
            await messagesGate.wait
            return {
              success: true,
              data: { messages: [{ type: 'user', role: 'user', content: 'from engine', timestamp: 0 }], totalMessageCount: 1 },
            }
          },
          // Mirrors the seeded sessionList. A stub that answers `[]` while the test
          // asserts a session exists contradicts its own fixture: the delayed list
          // refresh then wipes the row the projection reads, and whether that lands
          // before the assertion is pure timing — it did on Windows, not on macOS.
          list: async () => listRows,
          listRuntimes: async () => [],
        },
        relay: {
          sessions: async () => remoteRows.map((session) => ({
            session,
            ref: { peer: REMOTE_REF.peer, roomId: session.sessionId },
          })),
          openSession: async (ref: RemoteSessionRef) => {
            await remoteGate.wait
            return {
              ref,
              events: [{ type: 'user_input', text: `remote ${ref.roomId}`, ts: 1 }],
              truncated: false,
            }
          },
        },
        workspace: {
          setActive: async (id: string) => (id === OTHER_WORKSPACE.id ? OTHER_WORKSPACE : WORKSPACE),
        },
        ui: { flushPendingPrompts: async () => undefined },
        permissionRules: { workspaceStatus: async () => ({ hasWorkspaceRules: false }) },
        model: { listAvailable: async () => ({ success: true, data: { models: [] } }) },
      },
    },
  })
  ;({ useAppStore } = await import('./store'))
})

/** Drain the fire-and-forget history loads the previous test left in flight. */
async function quiesce(): Promise<void> {
  switchGate.release()
  messagesGate.release()
  remoteGate.release()
  lookupGate.release()
  await settle()
}

beforeEach(async () => {
  await quiesce()
  switchGate = gate()
  switchGate.release()
  messagesGate = gate()
  messagesGate.release()
  remoteGate = gate()
  remoteGate.release()
  lookupGate = gate()
  lookupGate.release()
  remoteRows = []
  useAppStore.setState({
    activeWorkspace: WORKSPACE,
    workspaces: [WORKSPACE, OTHER_WORKSPACE],
    activeSessionRuntimeId: null,
    piStatus: 'stopped',
    piPid: null,
    piError: null,
    sessionRuntimes: {},
    sessionState: null,
    sessionStats: null,
    sessionList: [],
    messages: [],
    promptHistory: [],
    activeRemoteRef: null,
    sessionLoading: false,
    currentView: 'chat',
    switchingToSessionFile: null,
    isStreaming: false,
    streamingContent: '',
  })
})

/**
 * Load a session once so the cache holds it, by opening it and letting the
 * engine answer.
 */
/** Let the fire-and-forget history load the switch kicks off actually run. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 50; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

async function warm(sessionPath: string, text: string): Promise<void> {
  // The main process answers the list from the same session that was just seeded,
  // so a delayed refresh cannot erase the row the projection needs.
  listRows = [{
    path: sessionPath, name: 'a', preview: text, sessionId: 'id', piSessionId: 'id',
    lastModified: 1, messageCount: 1, projectPath: WORKSPACE.path, projectName: WORKSPACE.name,
  }]
  useAppStore.setState({ sessionList: listRows })
  await useAppStore.getState().switchSession(sessionPath, WORKSPACE.path)
  await settle()
  assert.ok(
    useAppStore.getState().messages.length > 0,
    'the warm-up itself must have loaded a transcript',
  )
}

test('a stopped project paints its cached session instead of a spinner', async () => {
  await warm(SESSION, 'first')

  // Leave, then come back the way a project tab does. The resume lookup is held
  // so the only thing that can fill the chat is the paint that happens with the
  // switch itself — the whole point of the fix is that it does not wait for it.
  useAppStore.setState({ activeWorkspace: OTHER_WORKSPACE, messages: [] })
  lookupGate = gate()
  switchGate = gate()
  messagesGate = gate()

  const activation = useAppStore.getState().activateWorkspace(WORKSPACE.id)
  // The paint is synchronous with the workspace switch committing, so it lands
  // as soon as that one round trip answers — not after the history reload.
  await activation
  assert.deepEqual(
    useAppStore.getState().messages.map((message) => message.content),
    ['from engine'],
    'the cached transcript must be painted with the switch, not after the reload',
  )

  switchGate.release()
  messagesGate.release()
})

test('a session tab with a live runtime paints before the switch answers', async () => {
  await warm(SESSION, 'first')
  await warm(OTHER_SESSION, 'second')

  useAppStore.setState({ messages: [], sessionState: null, sessionLoading: false })
  switchGate = gate()
  // The switch is held, so nothing but a cache read can fill the chat.
  const switching = useAppStore.getState().switchSession(SESSION, WORKSPACE.path)
  // Past the 40 ms click-coalescing window: the paint happens then, and the
  // bind is still held, so nothing but a cache read can have filled the chat.
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.deepEqual(
    useAppStore.getState().messages.map((message) => message.content),
    ['from engine'],
    'a cached transcript must not wait on the runtime bind',
  )
  switchGate.release()
  await switching
})

test('a remote room is retained and repainted on the way back', async () => {
  remoteGate.release()
  await useAppStore.getState().openRemoteSession(REMOTE_REF)
  const loaded = useAppStore.getState().messages.map((message) => message.content)
  assert.deepEqual(loaded, ['remote room-abc'])

  // Leave for another room, then come back with the relay slow.
  remoteGate = gate()
  const back = useAppStore.getState().openRemoteSession(REMOTE_REF)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(
    useAppStore.getState().messages.map((message) => message.content),
    loaded,
    'a re-opened room must paint its retained transcript before the relay answers',
  )
  remoteGate.release()
  await back
})

test('a remote turn invalidates its retained transcript', async () => {
  remoteGate.release()
  await useAppStore.getState().openRemoteSession(REMOTE_REF)
  assert.ok(useAppStore.getState().messages.length > 0)

  // A completed turn means the retained copy is behind. The relay reports one
  // as an `agent_done` frame; the next open must therefore not paint it.
  useAppStore.getState().handleRelayFrame({ roomId: REMOTE_REF.roomId, frame: { type: 'agent_done' } } as never)
  useAppStore.setState({ messages: [] })
  remoteGate = gate()
  const reopening = useAppStore.getState().openRemoteSession(REMOTE_REF)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(
    useAppStore.getState().messages,
    [],
    'a stale remote transcript must not be painted as if it were current',
  )
  remoteGate.release()
  await reopening
})

test('a room that leaves the roster does not keep its transcript', async () => {
  remoteGate.release()
  await useAppStore.getState().openRemoteSession(REMOTE_REF)
  const withRoom = useAppStore.getState().messages.length
  assert.ok(withRoom > 0)

  // The roster no longer names the room: its chat is unreachable, so the
  // retained copy must be dropped rather than pinned against the budget.
  remoteRows = []
  await useAppStore.getState().refreshRemoteSessions()

  remoteGate = gate()
  const reopening = useAppStore.getState().openRemoteSession(REMOTE_REF)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(
    useAppStore.getState().messages,
    [],
    'a room missing from the roster must not paint a stale transcript',
  )
  remoteGate.release()
  await reopening
})

test('a cache miss does not blank a transcript already on screen', async () => {
  await warm(SESSION, 'first')

  // A chat on screen that the cache knows nothing about (a brand-new session
  // with a typed prompt, say). The paint helper must not clear it: only an
  // empty chat may be filled from cache. `switchSession` itself clears first,
  // so this asserts the helper's own precondition — the rule every caller
  // relies on rather than each re-deriving it inline, which is how two of them
  // ended up showing a spinner while holding the messages they were waiting for.
  useAppStore.setState({ messages: transcript('typed but unsent') })
  const before = useAppStore.getState().messages
  // Hold the bind so the window under test is the switch's own, not a
  // completed load that has already filled the chat legitimately.
  switchGate = gate()
  const switching = useAppStore.getState().switchSession('/tmp/one/never-loaded.jsonl', WORKSPACE.path)
  await new Promise((resolve) => setTimeout(resolve, 60))
  // The switch clears the chat; a miss must leave it empty rather than fill it
  // with a different session's transcript.
  const onScreen = useAppStore.getState().messages
  console.error('[dbg] onScreen', JSON.stringify(onScreen), 'switchingTo', useAppStore.getState().switchingToSessionFile, 'loading', useAppStore.getState().sessionLoading)
  assert.equal(onScreen.length, 0, 'a miss must not fill the chat from another session')
  assert.notEqual(onScreen, before, 'the switch must have cleared the previous chat')
  switchGate.release()
  await switching
  assert.ok(before.length > 0)
})
