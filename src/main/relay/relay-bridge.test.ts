import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SETTINGS } from '../../shared/default-settings'
import type { AppSettings, PairedRelayAgent, RelaySettings, RelayStatus } from '../../shared/ipc-contracts'
import type { RelayRoomInfo } from '../../shared/relay-protocol'
import { RelaySessionBridge, type RelayManagerLike } from './relay-bridge'
import type { RelayManagerState } from './relay-session-manager'

const AGENT: PairedRelayAgent = { pubkey: 'nJvBiqtqL1vZZNa0WpBynaj7EeNfq/g5fauzA516IcM=', agentName: 'macbook', roomId: 'room-abc', pairedAt: '2026-10-18T00:00:00.000Z' }
const ROOM: RelayRoomInfo = { cwd: '/Users/a/project', name: 'project', room_id: 'abc' }

class FakeManager implements RelayManagerLike {
  connected = false
  disconnected = false
  sent: string[] = []
  state: RelayManagerState = { status: 'idle', rooms: [], agent: null }
  private readonly changeListeners = new Set<(state: RelayManagerState) => void>()

  onChange(listener: (state: RelayManagerState) => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  listenerCount(): number {
    return this.changeListeners.size
  }

  /** Test hook: emit a change as the real manager does on a roster push. */
  emitChange(next: Partial<RelayManagerState>): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.changeListeners) listener(this.state)
  }
  async connect(): Promise<void> {
    this.connected = true
    this.state = { ...this.state, status: 'connected' }
  }
  disconnect(): void {
    this.disconnected = true
    this.state = { ...this.state, status: 'idle' }
  }
  async pair(input: Parameters<RelayManagerLike['pair']>[0]): Promise<PairedRelayAgent> {
    this.state = { ...this.state, status: 'paired', agent: AGENT }
    return { ...AGENT, agentName: input.agentName || AGENT.agentName }
  }
  async listRooms(): Promise<RelayRoomInfo[]> {
    // The roster the manager is currently holding, which a test drives through
    // `emitChange`, falling back to the single fixture room.
    return this.state.rooms.length > 0 ? this.state.rooms : [ROOM]
  }
  async selectRoom(roomId: string): Promise<PairedRelayAgent> {
    this.state = { ...this.state, agent: { ...AGENT, roomId } }
    return { ...AGENT, roomId }
  }
  async syncSession(): Promise<unknown> {
    // The reply ITSELF, not a wrapper: returning `{ events: reply }` made every
    // field of a freshly opened remote session undefined.
    return {
      type: 'session_history',
      in_reply_to: 'sync',
      session_started_at: 0,
      events: [{ ts: 1, type: 'user_input', text: 'hello' }],
      truncated: false,
      eos: true,
    }
  }
  async sendPrompt(text: string): Promise<void> {
    this.sent.push(text)
  }
  async cancel(): Promise<void> {
    this.sent.push('<cancel>')
  }
  getState(): RelayManagerState {
    return this.state
  }
}

interface Harness {
  bridge: RelaySessionBridge
  settings: AppSettings
  managers: FakeManager[]
  savedAgents: (PairedRelayAgent | null)[]
  disposed: FakeManager[]
  hasKeypair: boolean
  ensuredKeypairs: number
}

function harness(
  // Relay is partial too: a test that supplies only enabled/url/peer must not
  // restate the settings it does not care about. `harness` fills them in.
  initial: Omit<Partial<AppSettings>, 'relay'> & { relay?: Partial<RelaySettings> } = {},
  options: { keypairError?: Error } = {},
): Harness {
  const state = {
    // Relay defaults are merged one level down: a test that supplies only the
    // fields it cares about must not have to restate every other relay setting.
    settings: {
      ...DEFAULT_SETTINGS,
      ...initial,
      relay: { ...DEFAULT_SETTINGS.relay, ...initial.relay },
    } as AppSettings,
    managers: [] as FakeManager[],
    savedAgents: [] as (PairedRelayAgent | null)[],
    disposed: [] as FakeManager[],
    hasKeypair: initial.relay?.pairedAgent != null || Boolean(initial.relay?.url),
    ensuredKeypairs: 0,
  }

  const bridge = new RelaySessionBridge({
    settings: {
      read: async () => state.settings,
      write: async (patch) => {
        state.settings = { ...state.settings, ...patch } as AppSettings
      },
    },
    peers: {
      ensure: async () => {
        if (options.keypairError) throw options.keypairError
        state.ensuredKeypairs += 1
        if (!state.hasKeypair) state.hasKeypair = true
        return { keypair: { publicKeyBase64: AGENT.pubkey, privateKeyPem: 'pem' }, agent: state.settings.relay.pairedAgent }
      },
      save: async (agent) => {
        state.savedAgents.push(agent)
      },
    },
    createManager: async () => {
      const manager = new FakeManager()
      state.managers.push(manager)
      return manager
    },
    disposeManager: (manager) => state.disposed.push(manager as FakeManager),
  })

  return {
    bridge,
    get settings() {
      return state.settings
    },
    get ensuredKeypairs() {
      return state.ensuredKeypairs
    },
    managers: state.managers,
    savedAgents: state.savedAgents,
    disposed: state.disposed,
    get hasKeypair() {
      return state.hasKeypair
    },
  }
}

test('start does nothing when the relay was never configured', async () => {
  const subject = harness()
  await subject.bridge.start()
  assert.equal(subject.managers.length, 0)
  const status = await subject.bridge.getStatus()
  assert.equal(status.connection.status, 'idle')
  assert.equal(status.settings.enabled, false)
})

test('start connects once a url and keypair exist', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://192.168.1.223:3000', pairedAgent: AGENT } })
  await subject.bridge.start()
  assert.equal(subject.managers.length, 1)
  assert.equal(subject.managers[0].connected, true)
})

test('a fresh install mints a keypair before connecting, so pairing can start', async () => {
  // No stored keypair: `ensure` is what mints one, and pairing is impossible
  // without it because the key is the peer id the Pi records.
  const subject = harness({ relay: { enabled: true, url: 'http://192.168.1.223:3000', pairedAgent: null } })
  await subject.bridge.start()
  assert.equal(subject.ensuredKeypairs, 1)
  assert.equal(subject.managers.length, 1)
})

test('a keypair that cannot be created blocks the connection without throwing', async () => {
  // A broken userData directory must not take the app down at startup, and it
  // must not silently connect under an identity the Pi never recorded.
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: null } }, {
    keypairError: new Error('EACCES'),
  })
  await subject.bridge.start()
  assert.equal(subject.managers.length, 0)
  assert.equal((await subject.bridge.getStatus()).connection.status, 'idle')
})

test('setting a url enables the relay and builds a connection', async () => {
  const subject = harness()
  const status = await subject.bridge.setUrl('http://192.168.1.223:3000')
  assert.equal(subject.settings.relay.url, 'http://192.168.1.223:3000')
  assert.equal(subject.settings.relay.enabled, true)
  assert.equal(subject.managers.length, 1)
  assert.equal(status.settings.enabled, true)
})

test('clearing the url disables the relay and disposes the live manager', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://192.168.1.223:3000', pairedAgent: AGENT } })
  await subject.bridge.start()
  assert.equal(subject.managers.length, 1)

  const status = await subject.bridge.setUrl(null)
  assert.equal(subject.settings.relay.enabled, false)
  assert.equal(subject.settings.relay.url, null)
  assert.equal(subject.disposed.length, 1, 'the old socket must be closed before a new one exists')
  assert.equal(status.settings.enabled, false)
})

test('changing the url disposes the previous manager rather than running two sockets', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  await subject.bridge.start()
  await subject.bridge.setUrl('http://b:3000')

  assert.equal(subject.disposed.length, 1)
  assert.equal(subject.managers.length, 2)
  const first = subject.managers[0]
  assert.equal(subject.disposed[0], first)
})

test('pairing persists the agent returned by the Pi', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: null } })
  await subject.bridge.start()

  const agent = await subject.bridge.pair({ token: 'tok', targetPubkey: AGENT.pubkey, agentName: 'macbook', roomId: null })
  assert.equal(agent.pubkey, AGENT.pubkey)
  assert.equal(subject.savedAgents.length, 1)
  assert.equal(subject.savedAgents[0]?.pubkey, AGENT.pubkey)
})

test('unpairing clears the stored agent and keeps the manager usable for re-pairing', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  await subject.bridge.start()

  const status = await subject.bridge.unpair()
  assert.equal(subject.savedAgents.at(-1), null)
  assert.equal(status.settings.pairedAgent, null)
  assert.equal(subject.disposed.length, 1)
})

test('actions refuse to run when there is no connection at all', async () => {
  const subject = harness()
  await assert.rejects(() => subject.bridge.syncSession(), /Set a relay URL and pair/)
  await assert.rejects(() => subject.bridge.sendPrompt('hi'), /Set a relay URL and pair/)
  await assert.rejects(() => subject.bridge.cancel(), /Set a relay URL and pair/)
  await assert.rejects(() => subject.bridge.listRooms(), /Set a relay URL and pair/)
})

test('prompting and cancelling reach the manager once connected', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  await subject.bridge.start()

  await subject.bridge.sendPrompt('run the tests')
  await subject.bridge.cancel()
  assert.deepEqual(subject.managers[0].sent, ['run the tests', '<cancel>'])
})

test('a connection failure at startup is reported, not thrown', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  const original = FakeManager.prototype.connect
  FakeManager.prototype.connect = async () => {
    throw new Error('relay unreachable')
  }
  try {
    await subject.bridge.start()
  } finally {
    FakeManager.prototype.connect = original
  }
  const status = await subject.bridge.getStatus()
  // The manager still exists so the transport's own retry can take over.
  assert.equal(subject.managers.length, 1)
  assert.equal(status.connection.status, 'idle')
})

test('status never carries the keypair or a pairing token', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  await subject.bridge.start()
  const serialized = JSON.stringify(await subject.bridge.getStatus())
  assert.equal(serialized.includes('privateKeyPem'), false)
  assert.equal(serialized.includes('token'), false)
})

test('a roster push reaching the manager is forwarded to status listeners', async () => {
  // The panel redraws from pushed status. Without this the session list only
  // updates if the user happens to re-open Settings after the roster arrives.
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  const seen: RelayStatus[] = []
  subject.bridge.onStatusChange((status) => seen.push(status))
  await subject.bridge.start()

  const manager = subject.managers[0]!
  const room = { room_id: 'room-live', name: 'open-shaders', cwd: '/Users/a/project' }
  manager.emitChange({ status: 'paired', rooms: [room] })

  for (let i = 0; i < 100 && !seen.some((s) => s.connection.rooms.length === 1); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const latest = seen.at(-1)!
  assert.equal(latest.connection.rooms[0]?.room_id, 'room-live')
})

test('the manager subscription is dropped when the manager is replaced', async () => {
  // Two live managers would each push status and the roster would flap between
  // their room sets, which is the same failure as running two sockets.
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  await subject.bridge.start()
  const first = subject.managers[0]!

  await subject.bridge.setUrl('http://b:3000')
  const before = first.listenerCount()
  assert.equal(before, 0, 'the replaced manager must have no listeners left')
})

test('opening a remote session returns its history, not a wrapper around it', async () => {
  // The bug this guards: `syncSession` used to return `{ events: reply }`, so
  // `Array.isArray(result.events)` was false and every remote session painted as
  // an empty chat. Reverting the unwrap makes the assertions below read undefined.
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  await subject.bridge.start()
  subject.managers[0]!.emitChange({ status: 'paired', agent: AGENT, rooms: [ROOM] })

  const opened = await subject.bridge.openSession({ peer: AGENT.pubkey, roomId: 'abc' })

  assert.ok(Array.isArray(opened.events), `events must be a list, got ${typeof opened.events}`)
  assert.equal(opened.events.length, 1)
  assert.equal(opened.truncated, false)
  assert.equal(opened.ref.roomId, 'abc')
  assert.equal(opened.ref.peer, AGENT.pubkey)
})

test('a remote session row is named after its own session, not the folder', async () => {
  // Two sessions in one folder share that folder, so a row named after it makes
  // them indistinguishable in the sidebar and in the tab strip.
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  await subject.bridge.start()
  subject.managers[0]!.emitChange({
    status: 'paired',
    agent: AGENT,
    rooms: [ROOM, { ...ROOM, name: 'project#2', room_id: 'def' }],
  })

  const rows = await subject.bridge.sessions()

  assert.deepEqual(rows.map((row) => row.session.name), ['project', 'project#2'])
  assert.deepEqual(rows.map((row) => row.ref.roomId), ['abc', 'def'])
  // Two rooms in one folder must still be two rows, not one collapsed entry.
  assert.equal(new Set(rows.map((row) => row.session.path)).size, 2)
})
