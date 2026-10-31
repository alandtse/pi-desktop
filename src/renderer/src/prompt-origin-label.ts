import type { RemotePromptOrigin } from './store'
import type { SessionListItem } from '../../shared/ipc-contracts'
import { PEER_KEY_PREFIX_LENGTH, describeRemoteSession } from './utils/session-tabs'

/**
 * A human label for the session that raised a remote prompt, or `null`.
 *
 * Once a prompt can arrive while the user is looking at another session (or at a
 * local chat), the dialog has to say which session is asking — otherwise an
 * `ask_user` from a background chat is indistinguishable from one in the chat on
 * screen, and answering it is a guess about which turn the answer belongs to.
 *
 * `null` means "no origin to show": a local prompt belongs to whatever is on
 * screen by definition, so labelling it would only add noise.
 */
export function promptOriginLabel(
  origin: RemotePromptOrigin | null | undefined,
  sessionList: readonly SessionListItem[],
): string | null {
  if (!origin) return null
  const roomId = typeof origin.roomId === 'string' ? origin.roomId : ''
  const peer = typeof origin.peer === 'string' ? origin.peer : ''
  if (!roomId && !peer) return null

  // A listed row is the best label: it carries the folder and the session name,
  // the same pair the tab hover shows.
  const row = sessionList.find(
    (item) => item.remote && item.remote.roomId === roomId && (!peer || item.remote.peer === peer),
  )
  if (row) return describeRemoteSession(row, roomId)

  // A room can be absent from the list — it was closed, or its roster has not
  // arrived yet — and the prompt still needs a label, so fall back to the ids.
  if (peer) return `${peer.slice(0, PEER_KEY_PREFIX_LENGTH)} / ${roomId || '?'}`
  return roomId
}
