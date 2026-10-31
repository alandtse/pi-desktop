import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SETTINGS } from '../../shared/default-settings'
import type { AppSettings, PairedRelayAgent, RelaySettings, RelayStatus } from '../../shared/ipc-contracts'
import type { RelayRoomInfo } from '../../shared/relay-protocol'
import { createServer, type Server } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelaySessionBridge, type RelayManagerLike } from './relay-bridge'
import { resetLocalRoomsCache } from './local-rooms'
import type { RelayManagerState } from './relay-session-manager'

const AGENT: PairedRelayAgent = { pubkey: 'nJvBiqtqL1vZZNa0WpBynaj7EeNfq/g5fauzA516IcM=', agentName: 'macbook', roomId: 'room-abc', pairedAt: '2026-10-18T00:00:00.000Z' }
const ROOM: RelayRoomInfo = { cwd: '/Users/a/project', name: 'project', room_id: 'abc' }

/**
 * A room id that is genuinely live on this machine.
 *
 * Locality is decided by connecting to the cwd lock socket, so a fake cannot
 * stand in for it: the test binds a real socket in a temp REMOTE_PI_HOME and
 * lets the probe find it. That is the same signal production relies on.
 *
 * The address must be the one `lockAddress` uses, which is a FILE PATH on POSIX but
 * a NAMED PIPE on Windows. Binding a file path on Windows fails with EACCES, so the
 * whole locality feature would look broken here when only the fixture was wrong.
 */
const LOCAL_ROOM_ID = 'LocalRoom001'

function holdLocalLock(roomId: string): { release: () => Promise<void> } {
  const home = mkdtempSync(join(tmpdir(), 'pi-locks-'))
  const dir = join(home, '.pi', 'remote', 'locks')
  mkdirSync(dir, { recursive: true })
  const address =
    process.platform === 'win32'
      ? String.fromCharCode(92, 92, 46, 92) + 'pipe' + String.fromCharCode(92) + 'lock-' + roomId
      : join(dir, `${roomId}.sock`)
  const server: Server = createServer()
  server.listen(address)
  const previous = process.env['REMOTE_PI_HOME']
  process.env['REMOTE_PI_HOME'] = home
  resetLocalRoomsCache()
  return {
    release: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (previous === undefined) delete process.env['REMOTE_PI_HOME']
      else process.env['REMOTE_PI_HOME'] = previous
      resetLocalRoomsCache()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

class FakeManager implements RelayManagerLike {
  connected = false
  disconnected = false
  sent: string[] = []
  state: RelayManagerState = { status: 'idle', rooms: [], roomsByPeer: {}, agent: null, agents: [] }
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

test('a room is stamped with the machine that owns it, not the selected one', async () => {
  // With two machines paired, the roster carries rooms from both. Stamping every
  // room with the selected machine put the other machine's sessions under this
  // one's tab — the Windows sessions showed up under "This Mac" — and opening one
  // would have driven the wrong Pi.
  const OTHER: PairedRelayAgent = {
    pubkey: 'hKqfHH3rUAvSuwGI9yam2BkM5DCiiGlIgs53wFR+SiQ=',
    agentName: 'windows',
    roomId: 'room-win',
    pairedAt: '2026-10-20T00:00:00.000Z',
  }
  const subject = harness({
    relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT, pairedAgents: [AGENT, OTHER] },
  })
  await subject.bridge.start()
  subject.managers[0]!.emitChange({
    status: 'paired',
    agent: AGENT,
    agents: [AGENT, OTHER],
    rooms: [
      { ...ROOM, peer: AGENT.pubkey },
      { cwd: 'C:\\Users\\a\\proj', name: 'win-project', room_id: 'win1', peer: OTHER.pubkey },
    ],
  })

  const rows = await subject.bridge.sessions()
  const byRoom = new Map(rows.map((row) => [row.ref.roomId, row]))

  assert.equal(byRoom.get('abc')?.ref.peer, AGENT.pubkey)
  assert.equal(byRoom.get('win1')?.ref.peer, OTHER.pubkey, 'the Windows room must not be claimed by this Mac')
  // The synthetic path is what the sidebar groups on, so it has to carry the
  // owner too or both machines collapse into one group.
  assert.equal(byRoom.get('win1')?.session.path, `remote://${OTHER.pubkey}/win1`)
})

test('a room this machine is running never becomes a remote row', async () => {
  // A machine paired with itself is told about its own live sessions. The same
  // session already has a local row from disk, so listing it again as another
  // machine's would show one session twice.
  const lock = holdLocalLock(LOCAL_ROOM_ID)
  try {
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  await subject.bridge.start()
  const localRoom: RelayRoomInfo = {
    cwd: '/Users/a/local-project',
    name: 'local',
    room_id: LOCAL_ROOM_ID,
    peer: AGENT.pubkey,
  }
  subject.managers[0]!.emitChange({
    status: 'paired',
    agent: AGENT,
    rooms: [ROOM, localRoom],
  })

  const rows = await subject.bridge.sessions()

  assert.deepEqual(rows.map((row) => row.ref.roomId), ['abc'])
  } finally {
    await lock.release()
  }
})

test('the local rooms are reported on status so the row can show it is mesh-reachable', async () => {
  const lock = holdLocalLock(LOCAL_ROOM_ID)
  try {
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  await subject.bridge.start()
  const localRoom: RelayRoomInfo = {
    cwd: '/Users/a/local-project',
    name: 'local',
    room_id: LOCAL_ROOM_ID,
    peer: AGENT.pubkey,
  }
  subject.managers[0]!.emitChange({ status: 'paired', agent: AGENT, rooms: [ROOM, localRoom] })

  const status = await subject.bridge.getStatus()

  // The peer travels with the room: attaching to the running Pi needs both, and
  // starting a second writer on the same session file must stay avoidable.
  assert.deepEqual(status.connection.localRooms, [
    { roomId: LOCAL_ROOM_ID, peer: AGENT.pubkey, cwd: '/Users/a/local-project' },
  ])
  } finally {
    await lock.release()
  }
})

test('an unreachable relay reports no local rooms rather than guessing', async () => {
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  // Never connected: the status must still be well formed, because the sidebar
  // reads `localRooms` unconditionally.
  const status = await subject.bridge.getStatus()

  assert.deepEqual(status.connection.localRooms, [])
})

test('the pairing that is this machine itself is named so its tab can be dropped', async () => {
  // The tab strip seeds a tab per PAIRED agent, not per room, so a self-pairing
  // would keep a "This Mac" tab even after its rooms were filtered as local.
  // Main is where the key is readable, so main has to say which pairing it is.
  const subject = harness({ relay: { enabled: true, url: 'http://a:3000', pairedAgent: AGENT } })
  await subject.bridge.start()

  const status = await subject.bridge.getStatus()

  // Whatever the machine's own key is, the field is populated exactly once and
  // never throws when unreadable — the tab strip depends on it being present.
  assert.ok('ownPeer' in status.connection)
  assert.ok(
    status.connection.ownPeer === null || typeof status.connection.ownPeer === 'string',
    'ownPeer must be a key or null',
  )
})
