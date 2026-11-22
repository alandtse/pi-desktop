import type { PiRpcManager } from './pi-rpc-manager'
import type { TurnTracker } from './turn-tracker'
import type {
  PendingPromptCounts,
  PendingPromptItem,
  PiExtensionUiRequest,
  PiProcessStatus,
  PiRpcEvent,
} from '../shared/ipc-contracts'

/**
 * Routes Pi events from every workspace's PiRpcManager to the renderer.
 *
 * Non-dialog events keep the deliberate active-workspace-only filter: the
 * renderer's piStatus/stream state is a single global view and must track the
 * active workspace. Blocking extension-UI dialogs (select/confirm/input/editor)
 * are different — Pi holds the tool call until an answer arrives, with no
 * timeout on permission confirms — so dropping one from an inactive workspace
 * deadlocks that workspace's turn. The router instead:
 *
 *  - retains the one delivered dialog per workspace (renderer slot is
 *    reconstructible from main state at any moment via flush),
 *  - queues further dialogs per workspace and serializes delivery,
 *  - remembers each request's origin manager so the answer always reaches the
 *    Pi that asked, regardless of which workspace is active at answer time,
 *  - evicts a manager's held prompts when its process stops (a dead Pi can
 *    never consume an answer).
 *
 * Electron-free factory: all I/O goes through injected deps, so tests drive it
 * with bare emitters and an injected clock.
 */

const BLOCKING_UI_METHODS: ReadonlySet<PiExtensionUiRequest['method']> = new Set([
  'select',
  'confirm',
  'input',
  'editor',
])

interface QueuedPrompt {
  event: PiExtensionUiRequest
  receivedAt: number
}

export interface PiEventRouterDeps {
  getActiveManager(): PiRpcManager | null
  workspaceIdFor(manager: PiRpcManager): string | null
  runtimeIdFor(manager: PiRpcManager): string | null
  /** Forward one Pi event to the renderer (EVENT_PI). */
  broadcastEvent(event: PiRpcEvent): void
  /** Push a fresh pending-prompt snapshot to the renderer (EVENT_PENDING_PROMPTS). */
  broadcastPendingCounts(counts: PendingPromptCounts): void
  /** Resolve one manager's session file, for the mid-turn record. */
  sessionPathFor?(manager: PiRpcManager): string | null
  /** Observe turn boundaries so a quit can record which chats were working. */
  turnTracker?: TurnTracker
  now(): number
}

export interface PiEventRouter {
  /** Wire a manager's event/status-change/exit emissions into the router. Idempotent. */
  attachManager(manager: PiRpcManager): void
  /** Answer an extension-UI request, routing to its origin manager. */
  respond(id: string, response: Record<string, unknown>, runtimeId?: string): void
  /** (Re-)deliver the workspace's held dialog; no-op unless it is active now. */
  flush(workspaceId: string): void
  /** Snapshot of held prompts; reaps timed-out ones so the figures stay honest. */
  getPendingCounts(): PendingPromptCounts
  /** Full retained prompt list, including delivered and queued dialogs. */
  listPendingPrompts(): PendingPromptItem[]
  /** Re-broadcast counts after an active-workspace change; delivers nothing. */
  handleActiveWorkspaceChanged(): void
}

export function createPiEventRouter(deps: PiEventRouterDeps): PiEventRouter {
  // Blocking dialogs are owned by a Pi process, not a project. Multiple live
  // session runtimes may share one workspace cwd, so workspace-keyed queues
  // would deliver one session's prompt to another.
  const queues = new Map<PiRpcManager, QueuedPrompt[]>()
  // The one dialog currently owned by the renderer slot per Pi process. The
  // full payload is retained until answered or evicted so flush can replay it.
  const delivered = new Map<PiRpcManager, QueuedPrompt>()
  // Every blocking dialog's asking manager(s), until answered or evicted.
  // A set keeps routing safe even if two runtimes reuse a request id.
  const origins = new Map<string, Set<PiRpcManager>>()
  const attached = new WeakSet<PiRpcManager>()

  const isBlockingDialog = (event: PiRpcEvent): event is PiExtensionUiRequest =>
    event.type === 'extension_ui_request' && BLOCKING_UI_METHODS.has(event.method)

  const activeWorkspaceId = (): string | null => {
    const manager = deps.getActiveManager()
    return manager ? deps.workspaceIdFor(manager) : null
  }

  const track = (event: PiExtensionUiRequest): QueuedPrompt => ({ event, receivedAt: deps.now() })

  /**
   * Once the extension-supplied timeout elapses, Pi has auto-resolved the
   * request and deleted its pending entry, so a dialog shown from here on could
   * never be answered. Sole expiry rule for held prompts, queued or delivered.
   */
  const isExpired = (entry: QueuedPrompt): boolean =>
    entry.event.timeout !== undefined && deps.now() - entry.receivedAt >= entry.event.timeout

  const addOrigin = (id: string, manager: PiRpcManager): void => {
    const managers = origins.get(id) ?? new Set<PiRpcManager>()
    managers.add(manager)
    origins.set(id, managers)
  }

  const forgetOrigin = (id: string, manager: PiRpcManager): void => {
    const managers = origins.get(id)
    if (!managers) return
    managers.delete(manager)
    if (managers.size === 0) origins.delete(id)
  }

  /** Drop expired entries, forgetting their origins; returns the live ones. */
  const reapExpired = (manager: PiRpcManager, entries: readonly QueuedPrompt[]): QueuedPrompt[] => {
    const live: QueuedPrompt[] = []
    for (const entry of entries) {
      if (isExpired(entry)) forgetOrigin(entry.event.id, manager)
      else live.push(entry)
    }
    return live
  }

  /** An empty queue is deleted rather than stored, so counts omit zero entries. */
  const storeQueue = (manager: PiRpcManager, entries: QueuedPrompt[]): void => {
    if (entries.length === 0) queues.delete(manager)
    else queues.set(manager, entries)
  }

  const getPendingCounts = (): PendingPromptCounts => {
    // An EXPIRED delivered dialog must be released here, not merely excluded
    // from the figure. Only flush deletes a delivered entry, and flush is a
    // recovery path the renderer calls on mount, so a dialog that timed out
    // while the user was away would hold the slot and strand every prompt
    // queued behind it until the next mount. Pi resolves an expired request
    // itself without sending a cancel, so nothing else would move the queue.
    for (const [manager, entry] of delivered) {
      if (!isExpired(entry)) continue
      delivered.delete(manager)
      forgetOrigin(entry.event.id, manager)
      // Hand the freed slot over now, so the released dialog is replaced
      // instead of leaving the workspace with a visible count and no dialog.
      deliverNext(manager)
    }
    const counts: PendingPromptCounts = {}
    for (const [manager, entries] of queues) {
      const live = reapExpired(manager, entries)
      if (live.length !== entries.length) storeQueue(manager, live)
      const workspaceId = deps.workspaceIdFor(manager)
      if (workspaceId && live.length > 0) counts[workspaceId] = (counts[workspaceId] ?? 0) + live.length
    }
    for (const manager of delivered.keys()) {
      const workspaceId = deps.workspaceIdFor(manager)
      if (workspaceId) counts[workspaceId] = (counts[workspaceId] ?? 0) + 1
    }
    return counts
  }

  const listPendingPrompts = (): PendingPromptItem[] => {
    // Reap timed-out dialogs and promote the next queued one before returning
    // the snapshot, so the inbox never offers an answer Pi has already dropped.
    getPendingCounts()
    const prompts: PendingPromptItem[] = []
    const append = (manager: PiRpcManager, entry: QueuedPrompt): void => {
      const workspaceId = deps.workspaceIdFor(manager)
      if (!workspaceId) return
      prompts.push({
        request: entry.event,
        workspaceId,
        runtimeId: deps.runtimeIdFor(manager) ?? workspaceId,
        sessionPath: deps.sessionPathFor?.(manager) ?? null,
        receivedAt: entry.receivedAt,
      })
    }
    for (const [manager, entry] of delivered) append(manager, entry)
    for (const [manager, entries] of queues) {
      for (const entry of entries) append(manager, entry)
    }
    return prompts.sort((left, right) =>
      left.receivedAt - right.receivedAt ||
      left.runtimeId.localeCompare(right.runtimeId) ||
      left.request.id.localeCompare(right.request.id)
    )
  }

  const emitCounts = (): void => {
    deps.broadcastPendingCounts(getPendingCounts())
  }

  /**
   * Pop the workspace's queue into its empty delivered slot and broadcast,
   * reaping expired entries on the way. Returns whether state changed.
   */
  const deliverNext = (manager: PiRpcManager): boolean => {
    if (delivered.has(manager)) return false
    const entries = queues.get(manager)
    if (entries === undefined) return false
    const live = reapExpired(manager, entries)
    const next = live.shift()
    if (next !== undefined) {
      delivered.set(manager, next)
      deps.broadcastEvent(next.event)
    }
    storeQueue(manager, live)
    return live.length !== entries.length
  }

  const enqueue = (manager: PiRpcManager, event: PiExtensionUiRequest): void => {
    const entry = track(event)
    const queue = queues.get(manager)
    if (queue) queue.push(entry)
    else queues.set(manager, [entry])
  }

  const handleBlockingDialog = (manager: PiRpcManager, event: PiExtensionUiRequest): void => {
    addOrigin(event.id, manager)
    const workspaceId = deps.workspaceIdFor(manager)
    if (workspaceId === null) {
      // Manager unknown to the workspace registry: there is no queue slot to
      // hold it under, so deliver directly when active (origin routing above
      // still answers it) and let the inactive case fall through as a drop.
      if (manager === deps.getActiveManager()) deps.broadcastEvent(event)
      return
    }
    if (manager === deps.getActiveManager() && !delivered.has(manager)) {
      delivered.set(manager, track(event))
      deps.broadcastEvent(event)
    } else {
      // Inactive session runtime, or a dialog already on screen: hold for later.
      enqueue(manager, event)
    }
    emitCounts()
  }

  /**
   * Events the renderer needs even when the turn is in another chat. A finished
   * turn is one: a queue on a background chat only drains when its own turn ends,
   * and the end of a background turn reaches nobody unless it is forwarded. The
   * forwarded event carries its workspace so the renderer can tell which chat it
   * belongs to; anything chat-scoped stays on the active-session path.
   */
  const FORWARDED_FROM_BACKGROUND: ReadonlySet<string> = new Set([
    'agent_end',
  ])

  const handleManagerEvent = (manager: PiRpcManager, event: PiRpcEvent): void => {
    const sessionPath = deps.sessionPathFor?.(manager) ?? null
    // Observed before any routing decision: a background chat's turn boundaries
    // are exactly the ones this must not miss.
    deps.turnTracker?.observe(event, sessionPath)
    if (isBlockingDialog(event)) {
      handleBlockingDialog(manager, event)
      return
    }
    // Every event carries the session that produced it. The renderer cannot tell one
    // chat's stream from another's by looking at the event alone — the same types and
    // the same ids appear in all of them — so without this it applies whatever arrives
    // to whichever chat happens to be on screen. That is how a turn still streaming in
    // the chat you left painted itself over the one you opened.
    const sourced: PiRpcEvent = sessionPath === null ? event : ({ ...event, sessionPath } as unknown as PiRpcEvent)
    if (manager === deps.getActiveManager()) {
      deps.broadcastEvent(sourced)
      return
    }
    if (!FORWARDED_FROM_BACKGROUND.has(event.type)) return
    // A background chat has no workspace to attribute the event to when the
    // manager is unknown, and an unattributed end could settle another chat's
    // queue; drop it rather than guess.
    const workspaceId = deps.workspaceIdFor(manager)
    if (workspaceId === null) return
    deps.broadcastEvent({ ...sourced, backgroundWorkspaceId: workspaceId } as PiRpcEvent)
  }

  /**
   * A manager that stopped, crashed, or is restarting has abandoned its
   * pending requests: purge every prompt it originated so none can ghost-
   * deliver against a process that will never consume the answer.
   */
  const evictManager = (manager: PiRpcManager): void => {
    const ownedIds = [...origins]
      .filter(([, managers]) => managers.has(manager))
      .map(([id]) => id)
    const queued = queues.get(manager) ?? []
    const current = delivered.get(manager)
    if (ownedIds.length === 0 && queued.length === 0 && current === undefined) return
    for (const id of ownedIds) forgetOrigin(id, manager)
    for (const entry of queued) forgetOrigin(entry.event.id, manager)
    if (current) forgetOrigin(current.event.id, manager)
    queues.delete(manager)
    delivered.delete(manager)
    emitCounts()
  }

  const attachManager = (manager: PiRpcManager): void => {
    // WorkspaceManager's wiredPairs already dedups its listener attachment;
    // this guard makes the router safe against any second wiring path.
    if (attached.has(manager)) return
    attached.add(manager)
    manager.on('event', (event: PiRpcEvent) => handleManagerEvent(manager, event))
    manager.on('status-change', (status: PiProcessStatus) => {
      if (manager === deps.getActiveManager()) {
        deps.broadcastEvent({ type: 'status_change', ...manager.getStatus() })
      }
      if (status !== 'running') evictManager(manager)
    })
    // A startup-phase flip keeps status 'starting', so it is a separate signal:
    // routing it through 'status-change' would re-run evictManager and purge
    // extension UI prompts the still-starting engine already sent.
    manager.on('startup-phase', () => {
      if (manager === deps.getActiveManager()) {
        deps.broadcastEvent({ type: 'status_change', ...manager.getStatus() })
      }
    })
    manager.on('exit', () => {
      deps.turnTracker?.forget(deps.sessionPathFor?.(manager) ?? null)
      evictManager(manager)
    })
  }

  const respond = (id: string, response: Record<string, unknown>, runtimeId?: string): void => {
    const candidates = [...(origins.get(id) ?? [])]
    const activeManager = deps.getActiveManager()
    const origin = runtimeId !== undefined
      ? candidates.find((manager) => deps.runtimeIdFor(manager) === runtimeId) ?? null
      : activeManager && candidates.includes(activeManager)
        ? activeManager
        : candidates.length === 1
          ? candidates[0]
          : null
    if (origin) {
      forgetOrigin(id, origin)
      const entries = queues.get(origin) ?? []
      storeQueue(origin, entries.filter((entry) => entry.event.id !== id))
      if (delivered.get(origin)?.event.id === id) delivered.delete(origin)
    }
    // A runtime-bound response must never fall back to whichever Pi is active:
    // stale inbox cards should be harmless, not answer another runtime's prompt.
    const target = origin ?? (runtimeId === undefined && candidates.length === 0 ? deps.getActiveManager() : null)
    target?.sendExtensionUiResponse(id, response)
    if (origin !== null && origin === deps.getActiveManager()) deliverNext(origin)
    emitCounts()
  }

  const flush = (workspaceId: string): void => {
    // Only the active workspace and its active session runtime may be flushed:
    // a stale flush must not resurface another session's dialog.
    if (workspaceId !== activeWorkspaceId()) return
    const manager = deps.getActiveManager()
    if (!manager) return
    const held = delivered.get(manager)
    if (held !== undefined && !isExpired(held)) {
      // Self-healing re-broadcast: rebuilds the renderer slot after a reload,
      // a switch-back, or a same-workspace re-activation. The renderer's
      // id-guard tolerates the duplicate when the dialog is already up.
      deps.broadcastEvent(held.event)
      return
    }
    if (held !== undefined) {
      // The slot's dialog timed out while the workspace was away: releasing it
      // lets the next queued dialog take the slot instead of waiting on an
      // answer Pi would discard.
      delivered.delete(manager)
      forgetOrigin(held.event.id, manager)
    }
    const promoted = deliverNext(manager)
    if (held !== undefined || promoted) emitCounts()
  }

  return {
    attachManager,
    respond,
    flush,
    getPendingCounts,
    listPendingPrompts,
    handleActiveWorkspaceChanged: emitCounts,
  }
}
