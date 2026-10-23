import type {
  RemoteSessionRef,
  SessionListItem,
  SessionRuntimeInfo,
} from '../../../shared/ipc-contracts'
import { pathsEqual } from '../../../shared/path-compare'

/**
 * One entry in the top strip. A tab is an open CHAT, not a running process:
 * a session on another machine has no local runtime, and filtering the strip by
 * runtime left remote sessions reachable only from the sidebar — a second-class
 * thing rather than a session you switch to the way you switch to any other.
 */
export interface SessionTab {
  /** Stable across renames and reloads; the remote ref it derives from. */
  id: string
  kind: 'local' | 'remote'
  title: string
  /** Local tabs only: drives the runtime status indicator. */
  runtime: SessionRuntimeInfo | null
  /** Remote tabs only: what opening this tab again needs. */
  ref: RemoteSessionRef | null
}

/** Local tabs first (newest-first, as before), then remote ones. */
export function sessionTabs(options: {
  runtimes: Record<string, SessionRuntimeInfo>
  workspaceId: string | undefined
  sessionList: readonly SessionListItem[]
  /** Fallback name for a local runtime with no session list entry yet. */
  newSessionFallback: string
}): SessionTab[] {
  const local = Object.values(options.runtimes)
    .filter((runtime) => runtime.workspaceId === options.workspaceId && runtime.sessionPath)
    .reverse()
    .map((runtime): SessionTab => {
      const session = options.sessionList.find(
        (item) => item.path && runtime.sessionPath && pathsEqual(item.path, runtime.sessionPath),
      )
      return {
        id: runtime.runtimeId,
        kind: 'local',
        title: session?.name || session?.preview?.trim() || options.newSessionFallback,
        runtime,
        ref: null,
      }
    })

  // A remote row is an ordinary row that happens to name its transport, so the
  // strip reads it the same way rather than keeping a parallel list.
  const remote = options.sessionList
    .filter((item): item is SessionListItem & { remote: RemoteSessionRef } => item.remote !== undefined)
    .map((item): SessionTab => ({
      id: `remote:${item.remote.peer}:${item.remote.roomId}`,
      kind: 'remote',
      title: item.name || item.preview?.trim() || item.remote.hostname || item.sessionId,
      runtime: null,
      ref: item.remote,
    }))

  return [...local, ...remote]
}

/** True when this tab is the chat currently on screen. */
export function isTabActive(
  tab: SessionTab,
  activeRuntimeId: string | null,
  activeRemote: RemoteSessionRef | null,
): boolean {
  if (tab.kind === 'local') return tab.runtime !== null && tab.runtime.runtimeId === activeRuntimeId
  return (
    activeRemote !== null &&
    activeRemote.peer === tab.ref?.peer &&
    activeRemote.roomId === tab.ref?.roomId
  )
}
