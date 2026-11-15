/**
 * The messages a paired phone and the desktop app exchange over the remote
 * access WebSocket. The client set is a closed allowlist: there is no generic
 * passthrough to Pi RPC or to IPC, so a phone can never reach settings, files,
 * the terminal, or the permission mode.
 */
import type { PiExtensionUiRequest, PiRpcEvent, SessionListItem, SessionRuntimeInfo, Workspace } from './ipc-contracts'

export const REMOTE_PROTOCOL_VERSION = 1

export const MAX_PROMPT_CHARS = 32_000
export const MAX_ID_CHARS = 512
export const MAX_DEVICE_LABEL_CHARS = 80

// ─── Phone → desktop ────────────────────────────────────────────────────────

export type RemoteDialogResponse =
  | { kind: 'confirm'; confirmed: boolean }
  | { kind: 'select'; value: string | null }
  | { kind: 'input'; value: string | null }

export type RemoteClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'list_runtimes' }
  | { type: 'list_sessions'; workspaceId: string }
  | { type: 'open_session'; workspaceId: string; sessionPath: string }
  | { type: 'new_session'; workspaceId: string }
  | { type: 'subscribe'; runtimeId: string }
  | { type: 'unsubscribe'; runtimeId: string }
  | { type: 'prompt'; runtimeId: string; text: string }
  | { type: 'steer'; runtimeId: string; text: string }
  | { type: 'abort'; runtimeId: string }
  | { type: 'dialog_response'; dialogId: string; response: RemoteDialogResponse }

/** Every message a phone may send after it has authenticated. */
export type RemoteSessionMessage = Exclude<RemoteClientMessage, { type: 'auth' }>

// ─── Desktop → phone ────────────────────────────────────────────────────────

export type RemoteWorkspace = Pick<Workspace, 'id' | 'name' | 'path'>

export type RemoteErrorCode = 'bad_message' | 'not_found' | 'failed'

export type RemoteServerMessage =
  | { type: 'auth_ok'; protocolVersion: number; deviceLabel: string }
  | { type: 'auth_failed' }
  | { type: 'runtimes'; workspaces: RemoteWorkspace[]; runtimes: SessionRuntimeInfo[] }
  | { type: 'sessions'; workspaceId: string; sessions: SessionListItem[] }
  /**
   * The state of one runtime at subscribe time: the saved session history
   * (raw agent messages, parsed on the phone by the shared chat model) plus
   * the events of the turn in progress, so a phone that joins in the middle
   * of a streamed answer can rebuild the partial message.
   */
  | { type: 'snapshot'; runtimeId: string; messages: unknown[]; turnEvents: PiRpcEvent[] }
  | { type: 'pi_event'; runtimeId: string; event: PiRpcEvent }
  | { type: 'runtime_update'; runtime: SessionRuntimeInfo; closed: boolean }
  | { type: 'dialog'; runtimeId: string; request: PiExtensionUiRequest }
  | { type: 'dialog_resolved'; dialogId: string }
  | { type: 'error'; code: RemoteErrorCode; message: string }

// ─── Validation of what a phone sends ───────────────────────────────────────

type Fields = Record<string, unknown>

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty string no longer than the id limit, or null. */
function readId(fields: Fields, key: string): string | null {
  const value = fields[key]
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS ? value : null
}

/** A string with visible content, no longer than the prompt limit, or null. */
function readPromptText(fields: Fields): string | null {
  const value = fields.text
  if (typeof value !== 'string' || value.length > MAX_PROMPT_CHARS) return null
  return value.trim() ? value : null
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= MAX_PROMPT_CHARS)
}

function readDialogResponse(value: unknown): RemoteDialogResponse | null {
  if (!isFields(value)) return null
  switch (value.kind) {
    case 'confirm':
      return typeof value.confirmed === 'boolean' ? { kind: 'confirm', confirmed: value.confirmed } : null
    case 'select':
      return isStringOrNull(value.value) ? { kind: 'select', value: value.value } : null
    case 'input':
      return isStringOrNull(value.value) ? { kind: 'input', value: value.value } : null
    default:
      return null
  }
}

/**
 * Parse one WebSocket text frame from a phone. Returns a fresh object that
 * holds only the known fields of a known message, or null. Nothing a phone
 * sends reaches the app without passing through here.
 */
export function parseClientMessage(raw: string): RemoteClientMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isFields(parsed)) return null

  switch (parsed.type) {
    case 'auth': {
      const token = readId(parsed, 'token')
      return token ? { type: 'auth', token } : null
    }
    case 'list_runtimes':
      return { type: 'list_runtimes' }
    case 'list_sessions':
    case 'new_session': {
      const workspaceId = readId(parsed, 'workspaceId')
      return workspaceId ? { type: parsed.type, workspaceId } : null
    }
    case 'open_session': {
      const workspaceId = readId(parsed, 'workspaceId')
      const sessionPath = readId(parsed, 'sessionPath')
      return workspaceId && sessionPath ? { type: 'open_session', workspaceId, sessionPath } : null
    }
    case 'subscribe':
    case 'unsubscribe':
    case 'abort': {
      const runtimeId = readId(parsed, 'runtimeId')
      return runtimeId ? { type: parsed.type, runtimeId } : null
    }
    case 'prompt':
    case 'steer': {
      const runtimeId = readId(parsed, 'runtimeId')
      const text = readPromptText(parsed)
      return runtimeId && text ? { type: parsed.type, runtimeId, text } : null
    }
    case 'dialog_response': {
      const dialogId = readId(parsed, 'dialogId')
      const response = readDialogResponse(parsed.response)
      return dialogId && response ? { type: 'dialog_response', dialogId, response } : null
    }
    default:
      return null
  }
}
