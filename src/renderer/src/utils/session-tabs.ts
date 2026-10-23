import type {
  RemoteSessionRef,
  SessionListItem,
  SessionRuntimeInfo,
} from '../../../shared/ipc-contracts'
import { pathsEqual } from '../../../shared/path-compare'

/**
 * One remote MACHINE: the paired Pi, with every session it advertises.
 *
 * The machine is the tab, not the folder. A local project tab stands for one
 * folder on one machine, but a remote Pi is a whole other computer: folding its
 * folders into the same row as local projects said a remote folder was a
 * sibling of a local one, and left two folders on the same machine looking like
 * unrelated tabs. Sessions are the chats inside it, exactly as they are inside a
 * local project.
 */
export interface RemoteProjectTab {
  /** Stable for a peer; the tab's identity across roster changes. */
  id: string
  /** The machine's name, falling back to a short form of its key. */
  title: string
  /** Folders this machine runs sessions in, for the tab's tooltip. */
  paths: string[]
  /** Sessions on that machine, in roster order. */
  rows: { session: SessionListItem; ref: RemoteSessionRef }[]
}

/** Groups the relay's session rows by the machine each one runs on. */
export function remoteProjectTabs(sessionList: readonly SessionListItem[]): RemoteProjectTab[] {
  const groups = new Map<string, RemoteProjectTab>()
  for (const session of sessionList) {
    if (!session.remote) continue
    const { peer, roomId, hostname } = session.remote
    const folder = session.projectPath || session.projectName || ''
    const existing = groups.get(peer)
    const row = { session, ref: { peer, roomId, hostname } }
    if (existing) {
      existing.rows.push(row)
      if (folder !== '' && !existing.paths.includes(folder)) existing.paths.push(folder)
    } else {
      groups.set(peer, {
        id: `remoteMachine:${peer}`,
        // The machine's own reported name, never a folder: this tab is the
        // computer, and a folder name here would read as a second project.
        title: hostname || peer.slice(0, 8),
        paths: folder === '' ? [] : [folder],
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
 * A remote machine passes its sessions as `remoteRows`, so the chats of the
 * machine on screen sit in the same strip as the chats of a local project —
 * which is what makes a remote session switchable the way a local one is.
 */
export function sessionTabs(options: {
  runtimes: Record<string, SessionRuntimeInfo>
  workspaceId: string | undefined
  sessionList: readonly SessionListItem[]
  /** Sessions of the remote machine on screen, if one is. */
  remoteRows?: readonly { session: SessionListItem; ref: RemoteSessionRef }[]
  /** Fallback name for a local runtime with no session list entry yet. */
  newSessionFallback: string
}): SessionTab[] {
  const remote = (options.remoteRows ?? []).map((row): SessionTab => ({
    id: `remote:${row.ref.peer}:${row.ref.roomId}`,
    kind: 'remote',
    // A session is named by its session, not by the folder it shares with its
    // siblings: two sessions in one folder would otherwise read as one.
    title: row.session.name || row.session.preview?.trim() || row.ref.roomId,
    runtime: null,
    ref: row.ref,
  }))

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

  return [...remote, ...local]
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
