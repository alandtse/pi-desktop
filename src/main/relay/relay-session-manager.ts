/**
 * Drives a paired Pi: pairing, session sync, prompting, and cancellation.
 *
 * Protocol specifics are pure or injected, so the correlation rules are testable
 * without a relay.
 */
import { EventEmitter } from 'node:events'
import type { PairedRelayAgent } from '../../shared/ipc-contracts'
import type {
  RelayClientMessage,
  RelayExtensionUiResponse,
  RelayExtensionUiResponseBody,
  RelayInboundMessage,
  RelayRoomInfo,
  RelayActionName,
  RelayServerMessage,
  WireImage,
  WireModel,
} from '../../shared/relay-protocol'
import type { RelayTarget, RelayTransport, RelayTransportEvents, RelayTransportState } from './relay-transport'

export type RelayManagerStatus = 'idle' | 'connecting' | 'connected' | 'paired' | 'error'

export interface RelayManagerState {
  status: RelayManagerStatus
  detail?: string
  /**
   * Every paired machine's rooms, keyed by peer.
   *
   * Keyed rather than a flat list because each machine answers with its own
   * roster: a `rooms` frame names the peer it came from, and two machines replying
   * in turn must not overwrite each other. `rooms` below is the flattened view.
   */
  roomsByPeer: Record<string, RelayRoomInfo[]>
  /** Rooms every paired Pi currently advertises (one per live session). */
  rooms: RelayRoomInfo[]
  /** The machine this socket is pointed at, which is what a frame is addressed to. */
  agent: PairedRelayAgent | null
  /** Every machine this desktop is paired with, in pairing order. */
  agents: PairedRelayAgent[]
}

export interface RelayManagerOptions {
  transport: RelayTransport
  /** Where the pairing target (pubkey and name) is remembered between runs. */
  initialAgent?: PairedRelayAgent | null
  /** Every machine remembered between runs, in pairing order. */
  initialAgents?: PairedRelayAgent[]
  /** Persists a successful pairing; awaited so a crash cannot lose the credential. */
  onPaired?: (agent: PairedRelayAgent) => Promise<void> | void
  /**
   * Persists a room the manager adopted from the roster.
   *
   * Separate from `onPaired` so the bridge can tell a user-initiated pairing,
   * which it has already saved, from a repair it did not ask for.
   */
  onAdopted?: (agent: PairedRelayAgent) => Promise<void> | void
  requestTimeoutMs?: number
}

/**
 * The sync page size: everything the Pi is willing to send.
 *
 * The Pi clamps this to its own `REMOTE_PI_SYNC_LIMIT`, so asking for the maximum
 * cannot over-fetch; naming it keeps the intent visible at the call site.
 */
const SYNC_EVERYTHING = Number.MAX_SAFE_INTEGER

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

interface PendingRequest {
  resolve: (message: RelayServerMessage) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Correlates outbound requests with inbound replies by `in_reply_to`.
 *
 * The relay broadcasts: several peers can share a pubkey and every frame arrives
 * on one socket, so a reply is ours only when it names a request id we issued AND
 * comes from the peer we sent it to.
 */
export class RelaySessionManager extends EventEmitter {
  private state: RelayManagerState
  private readonly pending = new Map<string, PendingRequest>()
  private requestCounter = 0
  /** The id of the most recent prompt, which `cancel` names as its target. */
  private lastPromptId: string | null = null
  private readonly requestTimeoutMs: number
  /** Peers we asked for a roster from and have not heard back about yet. */
  private readonly rosterRequests = new Set<string>()
  /** Peers whose roster arrived since the last `listRooms` call. */
  private readonly rosterReplies = new Set<string>()
  private rosterWaiter: (() => void) | null = null

  constructor(private readonly options: RelayManagerOptions) {
    super()
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const initialAgents = options.initialAgents ?? (options.initialAgent ? [options.initialAgent] : [])
    this.state = {
      status: 'idle',
      rooms: [],
      roomsByPeer: {},
      // The selected machine is whichever the stored list names first unless the
      // caller pointed at a specific one.
      agent: options.initialAgent ?? initialAgents[0] ?? null,
      agents: initialAgents,
    }
    this.wireTransport()
  }

  getState(): RelayManagerState {
    return {
      ...this.state,
      rooms: [...this.state.rooms],
      roomsByPeer: { ...this.state.roomsByPeer },
      agents: [...this.state.agents],
    }
  }

  /** Notifies on every internal state change; returns an unsubscribe function. */
  onChange(listener: (state: RelayManagerState) => void): () => void {
    this.on('change', listener)
    return () => this.off('change', listener)
  }

  /**
   * Reports frames that are not a reply to one of our requests.
   *
   * These are the live ones — `agent_chunk`, `tool_request`, `session_history`
   * pushed unprompted — and `meta` carries the room so a caller can tell which
   * session a chunk belongs to. Typed here rather than left as a bare EventEmitter
   * event so the bridge cannot subscribe to the wrong name and silently see
   * nothing.
   */
  onMessage(listener: (message: RelayServerMessage, meta: { peer: string; room: string }) => void): () => void {
    this.on('message', listener)
    return () => this.off('message', listener)
  }

  private wireTransport(): void {
    const events: RelayTransportEvents = {
      onMessage: (message, meta) => this.handleMessage(message, meta),
      onStateChange: (transportState, detail) => this.handleTransportState(transportState, detail),
    }
    this.options.transport.setEvents(events)
  }

  private handleTransportState(transportState: RelayTransportState, detail?: string): void {
    if (transportState === 'connected') {
      this.subscribeToRoster()
      // Stay in 'paired' once we have an agent: a reconnect does not change
      // whether the user has paired.
      this.patch({ status: this.state.agent ? 'paired' : 'connected', detail })
      return
    }
    // A dropped connection discards the subscriptions *and* the roster we were
    // holding for them, so a reply recorded before it must not satisfy a later
    // `listRooms` with a stale snapshot.
    this.rosterReplies.clear()
    this.patch({ status: transportState, detail })
  }

  /**
   * Asks the relay to push this Pi's room set.
   *
   * Subscriptions are per connection and the relay drops them on disconnect, so
   * this must run on every `connected` transition, not just the first.
   */
  private subscribeToRoster(): void {
    // Every paired machine, in ONE control frame: the relay accepts a peer list,
    // so this is a single round trip rather than one per machine.
    const peers = this.pairedPeers()
    if (peers.length === 0) return
    this.options.transport.sendControl({ type: 'subscribe_rooms', peers })
    // Subscribing only registers interest; the relay pushes the CURRENT roster
    // to nobody, so without this check the list stays empty until some session
    // happens to start or stop. It also feeds room adoption on startup.
    this.options.transport.sendControl({ type: 'rooms_check', peers })
  }

  /** The peer keys of every paired machine, the selected one first. */
  private pairedPeers(): string[] {
    const selected = this.state.agent?.pubkey
    const peers = this.state.agents.map((machine) => machine.pubkey)
    if (selected && !peers.includes(selected)) peers.unshift(selected)
    else if (selected) peers.sort((a, b) => (a === selected ? -1 : b === selected ? 1 : 0))
    return peers
  }

  /** Rebuilds the flattened room list and tags each room with its machine. */
  private patchRooms(roomsByPeer: Record<string, RelayRoomInfo[]>): void {
    const rooms: RelayRoomInfo[] = []
    for (const machine of this.state.agents) {
      for (const room of roomsByPeer[machine.pubkey] ?? []) rooms.push({ ...room, peer: machine.pubkey })
    }
    // A roster can arrive for a peer this desktop has since unpaired; those rooms
    // are dropped rather than shown as rows that cannot be opened.
    this.patch({ roomsByPeer, rooms })
  }

  private patch(partial: Partial<RelayManagerState>): void {
    this.state = { ...this.state, ...partial }
    this.emit('change', this.getState())
  }

  async connect(): Promise<void> {
    this.patch({ status: 'connecting' })
    await this.options.transport.connect()
  }

  /**
   * Ensures the socket is up before an action that needs it.
   *
   * Actions go through this rather than assuming a prior `connect`, so a prompt
   * typed while the transport is retrying waits rather than fails.
   */
  private async ensureConnected(): Promise<void> {
    if (this.options.transport.getState() === 'connected') return
    await this.connect()
  }

  disconnect(): void {
    this.options.transport.close()
    // The replies recorded above belonged to the connection just closed.
    this.rosterReplies.clear()
    this.patch({ status: 'idle' })
  }

  /**
   * Sends a pairing request and waits for the Pi's verdict.
   *
   * The token is single-use and only the Pi can accept it, so relay-level
   * authentication of both keys is NOT a substitute for this step.
   */
  async pair(input: { token: string; targetPubkey: string; agentName: string; roomId: string | null }): Promise<PairedRelayAgent> {
    // The room is not known until the Pi answers: a pairing link carries the
    // peer, not which of its rooms to use.
    const provisional: PairedRelayAgent = {
      pubkey: input.targetPubkey,
      agentName: input.agentName,
      roomId: input.roomId,
      pairedAt: new Date().toISOString(),
    }

    await this.ensureConnected()

    // Subscribe before pairing: the Pi announces its rooms as soon as it accepts,
    // and a subscription made afterwards would miss that first announcement.
    this.options.transport.sendControl({ type: 'subscribe_rooms', peers: [input.targetPubkey] })

    const reply = await this.request(
      { type: 'pair_request', id: '', token: input.token, device_name: defaultDeviceName() },
      { peer: input.targetPubkey, room: input.roomId },
    ).catch((error: unknown) => {
      // A silent drop is the usual symptom of the two machines sitting on
      // DIFFERENT relays: the relay never had this peer, so it discards the
      // frame instead of replying. Say that, because the bare timeout reads
      // like an expired link and sends people to re-run /remote-pi pair.
      if (error instanceof Error && error.message.includes('did not answer')) {
        throw new Error(
          `${error.message}. The other machine is not on this relay — check that both machines use the same relay URL (it is not carried in the pairing link).`,
        )
      }
      throw error
    })

    if (reply.type === 'pair_error') {
      const detail = reply.message ?? reply.code
      this.patch({ status: 'error', detail })
      throw new Error(detail)
    }

    // `pair_ok` names the room this Pi is in. Without it every later frame goes
    // out addressed to `(peer, '')`, which the relay drops on the floor because
    // it looks the pair up exactly.
    const accepted = reply.type === 'pair_ok' ? reply : null
    const agent: PairedRelayAgent = {
      ...provisional,
      agentName: accepted?.session_name ?? provisional.agentName,
      roomId: accepted?.room_id ?? provisional.roomId,
      machineName: accepted?.hostname ?? provisional.machineName,
    }

    await this.options.onPaired?.(agent)
    this.patch({ status: 'paired', agent, rooms: [], detail: undefined })
    return agent
  }

  /**
   * Asks the paired Pi which sessions it currently have open.
   *
   * The relay answers with a separate `rooms` frame, so this waits for it
   * instead of returning whatever the last push happened to leave. A Pi that is
   * not connected to this relay never produces a frame, so the wait is bounded.
   */
  async listRooms(): Promise<RelayRoomInfo[]> {
    const target = this.requirePaired()
    await this.ensureConnected()
    // Every paired machine, not just the selected one: the sidebar lists all of
    // them, so a machine it never asks about would look like it had no sessions.
    for (const peer of this.pairedPeers()) {
      if (this.rosterReplies.has(peer) || this.rosterRequests.has(peer)) continue
      this.rosterRequests.add(peer)
      if (!this.options.transport.sendControl({ type: 'rooms_check', peers: [peer] })) {
        this.rosterRequests.delete(peer)
      }
    }

    // The relay dedups a `rooms_check` reply per (connection, peer): the first
    // answer is always sent and every identical snapshot after it is dropped. So
    // once THIS connection has answered, no further request can ever be answered
    // and waiting for one would time out on a roster we already hold. The flag is
    // therefore "this connection has a roster", not "a reply is waiting to be
    // read" — it is cleared on reconnect, where the next check is answered again.
    // Room starts and ends arrive as their own frames, so the held list stays
    // current without another snapshot.
    if (this.rosterReplies.has(target.peer)) {
      return this.getState().rooms
    }
    if (!this.rosterRequests.has(target.peer)) {
      this.rosterRequests.add(target.peer)
      if (!this.options.transport.sendControl({ type: 'rooms_check', peers: [target.peer] })) {
        this.rosterRequests.delete(target.peer)
        throw new Error('The relay connection is not open')
      }
    }

    // The selected machine is what the caller acts on, so its roster is the one
    // worth waiting for; the others fill in from the pushes that follow.
    await this.waitForRoster(target.peer)
    return this.getState().rooms
  }

  /** Resolves when `peer`'s roster arrives, or rejects once the timeout lapses. */
  private waitForRoster(peer: string): Promise<void> {
    if (this.rosterReplies.has(peer)) {
      this.clearRosterWait()
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clearRosterWait()
        this.rosterRequests.delete(peer)
        reject(
          new Error(
            `The paired Pi did not report its sessions within ${this.requestTimeoutMs}ms. It may have no session open, or it may be on a different relay.`,
          ),
        )
      }, this.requestTimeoutMs)
      this.rosterWaiter = () => {
        clearTimeout(timer)
        this.clearRosterWait()
        resolve()
      }
    })
  }

  private clearRosterWait(): void {
    this.rosterWaiter = null
  }

  /**
   * Pulls the live session transcript.
   *
   * Returns the `session_history` message ITSELF, not a wrapper around it: the
   * caller reads `events`, `truncated` and `session_started_at` off it, and a
   * wrapper made every one of those undefined — so a freshly opened remote
   * session painted as an empty chat until new turns streamed in.
   */
  async syncSession(): Promise<RelayServerMessage & { type: 'session_history' }> {
    const target = this.requirePaired()
    await this.ensureConnected()
    // The Pi clamps to its own `REMOTE_PI_SYNC_LIMIT` (30 by default), so asking
    // for more than that is a no-op but asking for nothing guarantees the 30.
    // A remote session should show the same depth of history a local one does,
    // so request the server's maximum rather than its minimum.
    const reply = await this.request({ type: 'session_sync', id: '', limit: SYNC_EVERYTHING }, target).catch((error: unknown) => {
      // The relay drops a frame for a `(peer, room)` pair with no live
      // connection and answers with nothing at all, so a timeout here means the
      // session is gone rather than the Pi being slow. Re-asking for the roster
      // lets the dead row disappear instead of being offered again.
      this.options.transport.sendControl({ type: 'rooms_check', peers: [target.peer] })
      throw error
    })
    if (reply.type === 'error') throw new Error(reply.message ?? reply.code)
    return reply as RelayServerMessage & { type: 'session_history' }
  }

  /**
   * Runs a typed action on the paired Pi.
   *
   * The Pi answers every action with `action_ok` or `action_error` naming the
   * action, so failures surface as errors here instead of being silent. Anything
   * the action changes (new history, a compaction notice, a model broadcast) still
   * arrives through the normal frame channels.
   */
  async runAction(
    action: RelayActionName,
    payload: { provider?: string; modelId?: string; level?: string } = {},
  ): Promise<void> {
    const target = this.requirePaired()
    await this.ensureConnected()
    const template: RelayClientMessage =
      action === 'model_set'
        ? { type: 'model_set', id: '', provider: payload.provider ?? '', model_id: payload.modelId ?? '' }
        : action === 'thinking_set'
          ? { type: 'thinking_set', id: '', level: payload.level ?? '' }
          : { type: action, id: '' }

    const reply = await this.request(template, target)
    if (reply.type === 'action_error') {
      throw new Error(typeof reply.error === 'string' ? reply.error : `The Pi refused ${action}`)
    }
  }

  /** Asks the paired Pi for its model catalog. */
  async listModels(): Promise<{ models: WireModel[]; current?: WireModel }> {
    const target = this.requirePaired()
    await this.ensureConnected()
    const reply = await this.request({ type: 'list_models', id: '' }, target)
    if (reply.type !== 'models_list') {
      throw new Error('The paired Pi did not return a model list')
    }
    return {
      models: Array.isArray(reply.models) ? (reply.models as WireModel[]) : [],
      current: reply.current as WireModel | undefined,
    }
  }

  /** Sends a prompt. The turn streams back as `agent_chunk` frames. */
  async sendPrompt(text: string, options?: { steer?: boolean; images?: WireImage[] }): Promise<void> {
    const target = this.requirePaired()
    await this.ensureConnected()
    const id = this.nextRequestId()
    const message: Extract<RelayClientMessage, { type: 'user_message' }> = { type: 'user_message', id, text }
    // Images ride on the same frame as the text (Plan/30); the Pi emits previews
    // and maps each to SDK image content before the model sees it.
    if (options?.images && options.images.length > 0) message.images = options.images
    // `steer` injects the text into the turn already running instead of queueing
    // it behind that turn, which is what a user typing mid-stream expects.
    if (options?.steer) message.streaming_behavior = 'steer'
    const sent = this.options.transport.send(message, target)
    if (!sent) throw new Error('The relay connection is not open')
    // Kept so `cancel` can name the message it stops.
    this.lastPromptId = id
  }

  async cancel(): Promise<void> {
    const target = this.requirePaired()
    await this.ensureConnected()
    // `cancel` names the message it stops. The Pi aborts whatever turn is running
    // and echoes this id back in `cancelled`, so a stale value is harmless for the
    // abort itself but would mislabel the ack; a prompt with no id is still a
    // legal cancel, so send an empty marker rather than refusing to stop.
    const targetId = this.lastPromptId ?? ''
    const id = this.nextRequestId()
    if (!this.options.transport.send({ type: 'cancel', id, target_id: targetId }, target)) {
      throw new Error('The relay connection is not open')
    }
  }

  /**
   * Answers an interactive prompt the paired Pi is blocked on.
   *
   * The Pi sends `extension_ui_request` for `ask_user` and waits for exactly one
   * response keyed by that request id. There is no retry: a turn left unanswered
   * holds until pi-ask's 10-minute flow TTL expires and then reports failure, so
   * a dropped response is a lost turn rather than a prompt to resend.
   */
  async respondExtensionUi(requestId: string, response: RelayExtensionUiResponseBody): Promise<void> {
    const id = typeof requestId === 'string' ? requestId.trim() : ''
    if (!id) throw new Error('An interactive response needs the request id it answers')
    const target = this.requirePaired()
    await this.ensureConnected()
    const message = { ...response, type: 'extension_ui_response', id } as RelayExtensionUiResponse
    if (!this.options.transport.send(message, target)) {
      throw new Error('The relay connection is not open')
    }
  }

  /**
   * Points this desktop at one of the Pi's rooms.
   *
   * A Pi can run several sessions from the same folder (remote-pi names them
   * `open-shaders` and `open-shaders#2`), and the relay addresses frames by the
   * exact `(peer, room)` pair. Without a choice here, prompts would have no
   * target whenever a Pi has more than one room open.
   */
  async selectRoom(roomId: string, peer?: string): Promise<PairedRelayAgent> {
    // Which MACHINE owns the room decides where the frames go, so the machine is
    // resolved first: with several paired Pis a room id alone is ambiguous, and
    // addressing the wrong peer silently delivers nothing.
    const owner =
      (peer ? this.state.agents.find((machine) => machine.pubkey === peer) : undefined) ??
      this.state.agents.find((machine) =>
        (this.state.roomsByPeer[machine.pubkey] ?? []).some((room) => room.room_id === roomId),
      )
    if (!owner) {
      const selected = this.state.agent
      if (!selected) throw new Error('This desktop is not paired with a Pi yet')
      throw new Error('That session is no longer open on the paired Pi')
    }
    const known = (this.state.roomsByPeer[owner.pubkey] ?? []).some((room) => room.room_id === roomId)
    if (!known) {
      // A row outlives the session it names: the Pi may have closed it since the
      // roster was pushed. Re-asking makes the stale row disappear instead of
      // leaving the user clicking it again.
      this.options.transport.sendControl({ type: 'rooms_check', peers: [owner.pubkey] })
      throw new Error('That session is no longer open on the paired Pi')
    }
    const selected: PairedRelayAgent = { ...owner, roomId }
    this.patch({ agent: selected })
    await this.options.onPaired?.(selected)
    return selected
  }

  private requirePaired(): RelayTarget {
    const agent = this.state.agent
    if (!agent) throw new Error('This desktop is not paired with a Pi yet')
    return { peer: agent.pubkey, room: agent.roomId }
  }

  private nextRequestId(): string {
    this.requestCounter += 1
    return `desktop-${Date.now().toString(36)}-${this.requestCounter}`
  }

  /** Resolves with the first reply naming our id; rejects on timeout. */
  private request(
    template: RelayClientMessage,
    target: RelayTarget,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<RelayServerMessage> {
    const id = this.nextRequestId()
    const message = { ...template, id } as RelayClientMessage

    return new Promise<RelayServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The paired Pi did not answer within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })

      if (!this.options.transport.send(message, target)) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('The relay connection is not open'))
        return
      }
    })
  }

  /**
   * Fills in a missing room id from the roster.
   *
   * A pairing made before `pair_ok`'s room was persisted leaves this desktop
   * addressing `(peer, '')`, which the relay drops silently. Rather than make
   * the user pair again, adopt the room the Pi is actually advertising. Only
   * done once, and only when the roster offers exactly one candidate, so a Pi
   * running several sessions is never guessed at.
   */
  private adoptRoomFromRoster(): void {
    const agent = this.state.agent
    if (!agent) return
    const rooms = this.state.rooms
    // Only when there is exactly one candidate: with several sessions open the
    // choice is the user's, and guessing would drive the wrong one.
    if (rooms.length !== 1) return
    const roomId = rooms[0]?.room_id
    if (!roomId) return
    // Also re-adopt when the stored room has gone away. A Pi restarted, or the
    // session we were driving was closed, leaves a stale id that the relay
    // silently drops; the Pi having exactly one room makes that the right one.
    if (agent.roomId === roomId) return
    const repaired: PairedRelayAgent = { ...agent, roomId }
    this.patch({ agent: repaired })
    void this.options.onAdopted?.(repaired)
  }

  private handleMessage(message: RelayInboundMessage, meta: { peer: string; room: string }): void {
    // Ignore traffic from any peer that is not the Pi we paired with: the relay
    // shares one socket across peers keyed by pubkey.
    const agent = this.state.agent
    if (agent && meta.peer && meta.peer !== agent.pubkey) return

    // A roster push names the peer it describes, so it is filtered by the same
    // pubkey check rather than trusted because it arrived first.
    if (message.type === 'rooms') {
      const tagged = (message.rooms ?? []).map((room) => ({ ...room, peer: meta.peer }))
      this.patchRooms({ ...this.state.roomsByPeer, [meta.peer]: tagged })
      // A `rooms_check` reply settles the matching wait; a broadcast also counts,
      // because either way the roster we now hold is fresh.
      this.rosterReplies.add(meta.peer)
      this.rosterRequests.delete(meta.peer)
      this.rosterWaiter?.()
      this.adoptRoomFromRoster()
      return
    }

    // A session opening or ending is pushed per session, never as a new roster,
    // so folding these in is what keeps the list correct after the one initial
    // `rooms_check` — without it the list only changes on reconnect.
    if (message.type === 'room_announced') {
      const announced = { ...toRoomInfo(message), peer: meta.peer }
      const peerRooms = this.state.roomsByPeer[meta.peer] ?? []
      const withoutIt = peerRooms.filter((room) => room.room_id !== announced.room_id)
      this.patchRooms({ ...this.state.roomsByPeer, [meta.peer]: [...withoutIt, announced] })
      this.adoptRoomFromRoster()
      return
    }

    if (message.type === 'room_meta_updated') {
      // Only sessions we already know about are patched: a meta frame names a
      // room but carries no cwd or name, so inventing an entry from it would put
      // a row in the list that the user cannot open.
      const peerRooms = this.state.roomsByPeer[meta.peer] ?? []
      const patched = peerRooms.map((room) =>
        room.room_id === message.room_id ? { ...room, ...message.meta } : room,
      )
      this.patchRooms({ ...this.state.roomsByPeer, [meta.peer]: patched })
      return
    }

    if (message.type === 'room_ended') {
      const peerRooms = this.state.roomsByPeer[meta.peer] ?? []
      this.patchRooms({
        ...this.state.roomsByPeer,
        [meta.peer]: peerRooms.filter((room) => room.room_id !== message.room_id),
      })
      return
    }

    const replyTo = (message as { in_reply_to?: string }).in_reply_to
    if (replyTo) {
      const pending = this.pending.get(replyTo)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(replyTo)
        pending.resolve(message)
        return
      }
    }

    this.emit('message', message, meta)
  }
}

/** Narrow a lifecycle frame to the session it describes. */
function toRoomInfo(frame: { room_id: string; name?: string; cwd?: string; model?: string; thinking?: string; working?: boolean; started_at?: number }): RelayRoomInfo {
  return {
    room_id: frame.room_id,
    name: frame.name ?? frame.room_id,
    cwd: frame.cwd ?? '',
    model: frame.model,
    thinking: frame.thinking,
    working: frame.working,
    started_at: frame.started_at,
  }
}

/** A label the Pi shows in its paired-device list. */
function defaultDeviceName(): string {
  try {
    return `Pi Desktop (${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'})`
  } catch {
    return 'Pi Desktop'
  }
}
