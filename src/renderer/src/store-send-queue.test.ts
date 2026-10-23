import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { PiRpcEvent, Workspace } from '../../shared/ipc-contracts'
import type { ComposerAttachment } from './store'
import { localQueueKey } from './send-queue'

// Prompts, steers and stops the store sent, in order.
const calls: string[] = []
const ACCEPTED = { type: 'response', command: 'prompt', success: true }
const WORKSPACE_ID = 'ws-queue'
const SESSION_FILE = '/sessions/queue-test.jsonl'
const CHAT_KEY = localQueueKey(SESSION_FILE, null)
const OTHER_WORKSPACE_ID = 'ws-other'
const OTHER_SESSION_FILE = '/sessions/queue-other.jsonl'
const OTHER_CHAT_KEY = localQueueKey(OTHER_SESSION_FILE, null)

const piDesktopStub = {
  pi: {
    getStatus: async () => ({ status: 'running' as const, pid: 1, error: null }),
  },
  commands: {
    prompt: async (message: string) => {
      calls.push(`prompt:${message}`)
      return ACCEPTED
    },
    steer: async (message: string) => {
      calls.push(`steer:${message}`)
      return { type: 'response', command: 'steer', success: true }
    },
    abort: async () => {
      calls.push('abort')
      return { type: 'response', command: 'abort', success: true }
    },
  },
  session: {
    // The engine runs the turn it was sent, so no prompt ends without an agent.
    getState: async () => ({ success: true, data: { isStreaming: true } }),
    getStats: async () => ({ success: true, data: null }),
    list: async () => [],
  },
  sendQueue: {
    load: async () => ({}),
    save: async () => undefined,
  },
}

type StoreModule = typeof import('./store')
let useAppStore: StoreModule['useAppStore']
let turnActivityTimes: StoreModule['turnActivityTimes']

before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { piDesktop: piDesktopStub }
  ;({ useAppStore, turnActivityTimes } = await import('./store'))
})

beforeEach(() => {
  calls.length = 0
  useAppStore.setState({
    messages: [],
    timelineEvents: [],
    streamingContent: '',
    streamingThinking: '',
    streamingToolCalls: new Map(),
    isStreaming: true,
    piStatus: 'running',
    piEngine: 'pi',
    activeWorkspace: { id: WORKSPACE_ID } as Workspace,
    sessionState: { sessionFile: SESSION_FILE } as never,
    activeChatKey: CHAT_KEY,
    activeRemoteRef: null,
    sendQueues: {},
    heldSendQueues: [],
  })
})

function emit(event: PiRpcEvent): void {
  useAppStore.getState().handlePiEvent(event)
}

// Let the async send chain (sendPrompt -> commands.prompt) run.
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

function queue(text: string, attachments: ComposerAttachment[] = [], key = CHAT_KEY): void {
  useAppStore.getState().queuePrompt(key, text, attachments)
}

function queuedTexts(key = CHAT_KEY): string[] {
  return (useAppStore.getState().sendQueues[key] ?? []).map((prompt) => prompt.text)
}

function endTurn(): void {
  emit({ type: 'agent_end', messages: [] } as PiRpcEvent)
}

test('the end of a turn sends the oldest queued message as a new prompt, one per turn', async () => {
  queue('first')
  queue('second')
  endTurn()
  await settle()
  assert.deepEqual(calls, ['prompt:first'])
  assert.deepEqual(queuedTexts(), ['second'])
  assert.equal(useAppStore.getState().isStreaming, true)

  endTurn()
  await settle()
  assert.deepEqual(calls, ['prompt:first', 'prompt:second'])
  assert.deepEqual(queuedTexts(), [])
})

test('a stopped turn holds the queue until the user sends again', async () => {
  queue('waiting')
  await useAppStore.getState().abort()
  endTurn()
  await settle()
  assert.deepEqual(calls, ['abort'])
  assert.deepEqual(queuedTexts(), ['waiting'])
  assert.deepEqual(useAppStore.getState().heldSendQueues, [CHAT_KEY])

  await useAppStore.getState().sendPrompt('new task')
  assert.deepEqual(useAppStore.getState().heldSendQueues, [])
  endTurn()
  await settle()
  assert.deepEqual(calls, ['abort', 'prompt:new task', 'prompt:waiting'])
})

test('a failed turn holds the queue, and a retry that works does not', async () => {
  queue('waiting')
  emit({ type: 'agent_start' } as PiRpcEvent)
  emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider down' } } as PiRpcEvent)
  endTurn()
  await settle()
  assert.deepEqual(calls, [])
  assert.deepEqual(useAppStore.getState().heldSendQueues, [CHAT_KEY])

  useAppStore.setState({ heldSendQueues: [], isStreaming: true })
  emit({ type: 'agent_start' } as PiRpcEvent)
  emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider down' } } as PiRpcEvent)
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' } } as PiRpcEvent)
  endTurn()
  await settle()
  assert.deepEqual(calls, ['prompt:waiting'])
})

test('Send now pushes a queued message into the running turn and takes it off the queue', async () => {
  queue('keep going')
  queue('later')
  const [first] = useAppStore.getState().sendQueues[CHAT_KEY]
  await useAppStore.getState().sendQueuedPromptNow(CHAT_KEY, first.id)
  assert.deepEqual(calls, ['steer:keep going'])
  assert.deepEqual(queuedTexts(), ['later'])
})

test('a queued message keeps its files: text files go out inlined', async () => {
  const notes: ComposerAttachment = { kind: 'text', name: 'notes.md', path: '/p/notes.md', content: 'Line one' }
  queue('Read this', [notes])
  endTurn()
  await settle()
  assert.equal(calls.length, 1)
  assert.ok(calls[0].startsWith('prompt:Read this'))
  assert.ok(calls[0].includes('Line one'))
})

test("another chat's queue is not sent by this chat's turn", async () => {
  queue('elsewhere', [], OTHER_CHAT_KEY)
  endTurn()
  await settle()
  assert.deepEqual(calls, [])
  const [elsewhere] = useAppStore.getState().sendQueues[OTHER_CHAT_KEY]
  // Sending now would put this message in the chat on screen, so it is refused
  // and the message stays queued for the chat it was written for.
  await useAppStore.getState().sendQueuedPromptNow(OTHER_CHAT_KEY, elsewhere.id)
  assert.deepEqual(calls, [])
  assert.deepEqual(queuedTexts(OTHER_CHAT_KEY), ['elsewhere'])
})

test("a background chat's turn end drains its own queue, not the visible chat's", async () => {
  queue('mine', [], CHAT_KEY)
  queue('theirs', [], OTHER_CHAT_KEY)
  // The end of a turn in another chat carries the workspace it happened in; this
  // chat has its own queue and must keep it.
  emit({ type: 'agent_end', messages: [], backgroundWorkspaceId: OTHER_WORKSPACE_ID } as PiRpcEvent)
  await settle()
  assert.deepEqual(calls, [])
  assert.deepEqual(queuedTexts(CHAT_KEY), ['mine'])
  assert.deepEqual(queuedTexts(OTHER_CHAT_KEY), ['theirs'])
})

test('every change to the queue is written out for the next run', async () => {
  useAppStore.getState().queuePrompt(CHAT_KEY, 'persist me', [])
  await settle()
  assert.deepEqual(useAppStore.getState().sendQueues[CHAT_KEY].map((prompt) => prompt.text), ['persist me'])
  const written = useAppStore.getState().sendQueues
  assert.ok(Object.prototype.hasOwnProperty.call(written, CHAT_KEY))
})

test('the activity clock starts with the turn and moves with every agent event', async () => {
  useAppStore.setState({ isStreaming: false })
  const beforeStart = Date.now()
  useAppStore.setState({ isStreaming: true })
  const { startedAt, lastEventAt } = turnActivityTimes()
  assert.ok(startedAt >= beforeStart)
  assert.equal(lastEventAt, startedAt)

  await new Promise((resolve) => setTimeout(resolve, 5))
  emit({ type: 'queue_update', steering: [], followUp: [] })
  assert.ok(turnActivityTimes().lastEventAt > startedAt)
  assert.equal(turnActivityTimes().startedAt, startedAt)
})
