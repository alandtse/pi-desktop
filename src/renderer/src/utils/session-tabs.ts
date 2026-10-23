import type {
  RemoteSessionRef,
  SessionListItem,
  SessionRuntimeInfo,
} from '../../../shared/ipc-contracts'
import { pathsEqual } from '../../../shared/path-compare'

/**
 * One remote PROJECT: every session the paired Pi runs from one folder.
 *
 * A session on the other machine belongs to a folder there, and that folder is
 * the same level of thing as a local project tab. Putting the sessions straight
 * into the strip nested them under whichever local project happened to be
 * active, which said they belonged to a folder on THIS machine.
 */
export interface RemoteProjectTab {
  /** Stable for a peer + folder; the tab's identity across roster changes. */
  id: string
  title: string
  hostname: string | null
  /** Sessions in this folder on that machine, oldest roster order kept. */
  rows: { session: SessionListItem; ref: RemoteSessionRef }[]
}

/**
 * The last segment of a path from either platform.
 *
 * Split on both separators instead of one regex class: the same relay roster can
 * name a POSIX folder and a Windows one, and the escaping in a class with a
 * backslash is easy to get wrong and silent when it is.
 */
function lastPathSegment(value: string): string {
  return value.split('/').filter(Boolean).pop()?.split('\\').filter(Boolean).pop() ?? ''
}

/** Groups the relay's session rows by the folder each one runs in. */
export function remoteProjectTabs(sessionList: readonly SessionListItem[]): RemoteProjectTab[] {
  const groups = new Map<string, RemoteProjectTab>()
  for (const session of sessionList) {
    if (!session.remote) continue
    const { peer, roomId, hostname } = session.remote
    const folder = session.projectPath || session.projectName || peer
    const id = `remoteProject:${peer}:${folder}`
    const existing = groups.get(id)
    const row = { session, ref: { peer, roomId, hostname } }
    if (existing) existing.rows.push(row)
    else {
      groups.set(id, {
        id,
        // The folder name is what a project tab shows locally, so the same
        // thing is shown here rather than the remote machine's whole path.
        title: session.projectName || lastPathSegment(folder) || folder,
        hostname: hostname ?? null,
        rows: [row],
      })
    }
  }
  return [...groups.values()]
}

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

/**
 * The chats open in ONE project, newest-first.
 *
 * Only local chats appear here: a session on another machine belongs to a
 * folder on that machine, so it is a project-level tab of its own rather than a
 * chat inside whichever local project happens to be active.
 */
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

  return local
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
