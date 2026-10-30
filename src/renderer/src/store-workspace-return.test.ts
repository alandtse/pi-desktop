/**
 * The reported failure: switching from a project to another project and back
 * left the chat on a loading screen.
 *
 * The A → B → A cycle is not the same as two independent switches. Coming back
 * to A re-enters a runtime that already exists and is already `running`, so
 * `activateWorkspace` takes the `live` branch — which hydrates through
 * `reloadActiveSession` instead of `openLastSession`, and `reloadActiveSession`
 * returns immediately unless `piStatus === 'running'` at that exact moment.
 *
 * These tests hold the ordering still: the chat must leave the loading state on
 * every path home, whether the runtime is live or stopped, and whether the
 * transcript came from cache or from the engine.
 */
import { before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionRuntimeInfo, Workspace } from '../../shared/ipc-contracts'

const HOME: Workspace = {
  id: 'home', name: 'home', path: '/tmp/home', color: '#000', createdAt: 0, lastActiveAt: 0,
}
const SHADERS: Workspace = {
  id: 'shaders', name: 'shaders', path: '/tmp/shaders', color: '#000', createdAt: 0, lastActiveAt: 0,
}
const HOME_SESSION = '/tmp/home/.pi/sessions/home.jsonl'
const SHADERS_SESSION = '/tmp/shaders/.pi/sessions/shaders.jsonl'

function runtime(overrides: Partial<SessionRuntimeInfo> = {}): SessionRuntimeInfo {
  return {
    runtimeId: 'rt-home', workspaceId: HOME.id, sessionPath: HOME_SESSION, sessionId: 'home',
    activity: null, active: true, status: 'running', pid: 1, error: null,
    ...overrides,
  }
}

let useAppStore: typeof import('./store')['useAppStore']
/** What main would answer for `session.switch`, per requested path. */
let switchAnswer: (path: string) => SessionRuntimeInfo
/** Delay `session.switch` so "before it answers" is observable. */
let switchDelay = 0
before(async () => {
  Object.assign(globalThis, {
    window: {
      piDesktop: {
        session: {
          resumeTarget: async (cwd: string) => (cwd === HOME.path ? HOME_SESSION : SHADERS_SESSION),
          switch: async (path: string) => {
            if (switchDelay) await new Promise((resolve) => setTimeout(resolve, switchDelay))
            return switchAnswer(path)
          },
          getState: async () => ({ success: true, data: { messageCount: 2 } }),
          getStats: async () => ({ success: true, data: null }),
          getMessages: async () => ({
            success: true,
            data: {
              messages: [{ type: 'user', role: 'user', content: 'hello', timestamp: 0 }],
              totalMessageCount: 2,
            },
          }),
          list: async () => [],
          listRuntimes: async () => [],
          interruption: async () => null,
          interruptedChats: async () => [],
        },
        relay: { sessions: async () => [], openSession: async () => ({}) },
        workspace: { setActive: async (id: string) => (id === SHADERS.id ? SHADERS : HOME) },
        ui: { flushPendingPrompts: async () => undefined, setEditorDirty: () => undefined },
        permissionRules: { workspaceStatus: async () => ({ hasWorkspaceRules: false }) },
        model: { listAvailable: async () => ({ success: true, data: { models: [] } }) },
      },
    },
  })
  ;({ useAppStore } = await import('./store'))
})

beforeEach(() => {
  switchDelay = 0
  switchAnswer = (path) => runtime({
    sessionPath: path,
    workspaceId: path === HOME_SESSION ? HOME.id : SHADERS.id,
    runtimeId: path === HOME_SESSION ? 'rt-home' : 'rt-shaders',
  })
  useAppStore.setState({
    activeWorkspace: HOME,
    workspaces: [HOME, SHADERS],
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
    switchingToSessionFile: null,
    isStreaming: false,
    streamingContent: '',
    currentView: 'chat',
  })
})

/** Wait out the switch pipeline and every fire-and-forget load it starts. */
async function settle(rounds = 60): Promise<void> {
  for (let tick = 0; tick < rounds; tick += 1) await new Promise((resolve) => setTimeout(resolve, 2))
}

/** Open a session the way the sidebar does. */
async function open(path: string, workspace: Workspace): Promise<void> {
  await useAppStore.getState().switchSession(path, workspace.path)
  await settle()
}

/** Switch to a project the way a project tab does, from wherever we are. */
async function goTo(workspace: Workspace): Promise<void> {
  await useAppStore.getState().activateWorkspace(workspace.id)
  await settle()
}

test('coming home to a live runtime ends the loading state', async () => {
  await open(HOME_SESSION, HOME)
  await goTo(SHADERS)
  await open(SHADERS_SESSION, SHADERS)

  // The runtime for home is still registered and still running — this is the
  // state a user returns to after a couple of tab switches.
  useAppStore.setState({
    sessionRuntimes: { 'rt-home': runtime() },
    sessionState: null,
    messages: [],
    piStatus: 'stopped',
  })
  await useAppStore.getState().activateWorkspace(HOME.id)
  await settle()

  const state = useAppStore.getState()
  assert.equal(state.activeWorkspace?.id, HOME.id)
  assert.equal(state.sessionLoading, false, 'the loading spinner must not survive the return')
  assert.ok(state.messages.length > 0, 'the session must be repainted, not left empty')
})

test('coming home to a stopped runtime ends the loading state', async () => {
  await open(HOME_SESSION, HOME)
  await goTo(SHADERS)
  await open(SHADERS_SESSION, SHADERS)

  useAppStore.setState({ sessionRuntimes: {}, sessionState: null, messages: [], piStatus: 'stopped' })
  await useAppStore.getState().activateWorkspace(HOME.id)
  await settle()

  const state = useAppStore.getState()
  assert.equal(state.activeWorkspace?.id, HOME.id)
  assert.equal(state.sessionLoading, false)
  assert.ok(state.messages.length > 0)
})

test('a switch whose bind answers after a workspace change still clears loading', async () => {
  // The real race: `setActive` resolves while the previous switch is still
  // awaiting its bind. Generation guards make the late answer a no-op, so
  // whoever owns the newest load has to be able to clear the flag.
  await open(HOME_SESSION, HOME)
  switchDelay = 40
  const leaving = useAppStore.getState().switchSession(SHADERS_SESSION, SHADERS.path)
  await useAppStore.getState().activateWorkspace(HOME.id)
  await leaving
  await settle()

  const state = useAppStore.getState()
  assert.equal(state.activeWorkspace?.id, HOME.id)
  assert.equal(state.sessionLoading, false, 'a stale bind must not leave the new workspace spinning')
})

test('a rapid A → B → A leaves no project spinning', async () => {
  // The reported sequence, with the speed a user actually clicks at: the return
  // to A starts before B's project activation has finished opening its own last
  // session. Each activation bumps the generation, so the in-flight switch for
  // the previous project is abandoned — and whatever it had set must not be the
  // last word on the loading state.
  await open(HOME_SESSION, HOME)
  await goTo(SHADERS)
  await open(SHADERS_SESSION, SHADERS)

  switchDelay = 30
  // Deliberately not awaited: the user has already clicked the other tab.
  void useAppStore.getState().activateWorkspace(HOME.id)
  await new Promise((resolve) => setTimeout(resolve, 5))
  void useAppStore.getState().activateWorkspace(SHADERS.id)
  await new Promise((resolve) => setTimeout(resolve, 5))
  void useAppStore.getState().activateWorkspace(HOME.id)
  await settle(120)

  const state = useAppStore.getState()
  assert.equal(state.activeWorkspace?.id, HOME.id)
  assert.equal(state.sessionLoading, false, 'a superseded switch must not leave the chat loading')
})

test('clicking back before the first switch commits is not swallowed', async () => {
  await open(HOME_SESSION, HOME)
  await goTo(SHADERS)
  await open(SHADERS_SESSION, SHADERS)

  // `activateWorkspace` only records the new workspace AFTER `setActive`
  // answers. Until then `activeWorkspace` is still the project being left, so a
  // click on that project hits the "already there" early return and does
  // nothing — while the first activation is still in flight and will commit over
  // it. The user ends up on the project they clicked away from, mid-load.
  switchDelay = 40
  void window.piDesktop.workspace.setActive
  const first = useAppStore.getState().activateWorkspace(HOME.id)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await useAppStore.getState().activateWorkspace(SHADERS.id)
  await first
  await settle(120)

  const state = useAppStore.getState()
  assert.equal(state.sessionLoading, false, 'the chat must not be left loading')
  assert.equal(state.activeWorkspace?.id, SHADERS.id, 'the last click wins')
})

test('a history fetch abandoned mid-flight does not leave loading stuck', async () => {
  await open(HOME_SESSION, HOME)
  await goTo(SHADERS)
  await open(SHADERS_SESSION, SHADERS)

  // Coming home to a live runtime hydrates through `reloadActiveSession`, which
  // awaits `getMessages` and then bails on `!isCurrent()` when a newer switch
  // bumped the generation. That bail is correct — the newer load owns the view —
  // but it returns WITHOUT clearing `sessionLoading`, and if the newer load took
  // the cache path it may already have cleared it, leaving the two racing.
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  const realGetMessages = window.piDesktop.session.getMessages
  window.piDesktop.session.getMessages = (async () => {
    await held
    return realGetMessages()
  }) as typeof realGetMessages

  useAppStore.setState({
    sessionRuntimes: { 'rt-home': runtime() },
    sessionState: null,
    messages: [],
    piStatus: 'stopped',
  })
  const home = useAppStore.getState().activateWorkspace(HOME.id)
  await new Promise((resolve) => setTimeout(resolve, 30))
  // Supersede it while the fetch is still open, then come straight back.
  void useAppStore.getState().activateWorkspace(SHADERS.id)
  await new Promise((resolve) => setTimeout(resolve, 5))
  release()
  await home
  await settle(140)

  const state = useAppStore.getState()
  assert.equal(state.activeWorkspace?.id, SHADERS.id)
  assert.equal(state.sessionLoading, false, 'the abandoned fetch must not strand the loading state')
})

test('coming home to a live runtime reuses its cached transcript', async () => {
  // The reported bug, at its root. Returning to a project whose runtime is live
  // goes through `reloadActiveSession`, which keys its cache lookup off
  // `switchingToSessionFile ?? sessionState?.sessionFile`. The workspace switch
  // nulled `sessionState` and — before this fix — never set the other, so the
  // lookup always missed and the chat refetched history it was already holding.
  await open(HOME_SESSION, HOME)
  await goTo(SHADERS)
  await open(SHADERS_SESSION, SHADERS)

  useAppStore.setState({
    sessionRuntimes: { 'rt-home': runtime() },
    sessionState: null,
    messages: [],
    piStatus: 'stopped',
  })

  // A getMessages that never answers: only a cache hit can end the load.
  const realGetMessages = window.piDesktop.session.getMessages
  let fetchCalled = false
  window.piDesktop.session.getMessages = (async () => {
    fetchCalled = true
    return new Promise(() => {})
  }) as typeof realGetMessages

  try {
    await useAppStore.getState().activateWorkspace(HOME.id)
    await settle(30)
    const state = useAppStore.getState()
    assert.equal(fetchCalled, false, 'the transcript was already held; it must not be refetched')
    assert.equal(state.sessionLoading, false, 'and the chat must leave the loading state')
    assert.ok(state.messages.length > 0, 'with the conversation on screen')
  } finally {
    window.piDesktop.session.getMessages = realGetMessages
  }
})
