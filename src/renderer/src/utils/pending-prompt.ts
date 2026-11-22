import type { PiExtensionUiRequest, PendingPromptItem } from '../../../shared/ipc-contracts'

export type PendingPromptAnswer = { confirmed: boolean } | { value: string }

export type PendingPromptResponse =
  | { kind: 'confirm'; confirmed: boolean }
  | { kind: 'value'; value: string }

/** Replies are scoped to a runtime and never treat relay prompts as local. */
export function isPendingPromptAlreadyOpen(
  item: PendingPromptItem,
  activeRequest: PiExtensionUiRequest | null,
  activeRuntimeId: string | null,
  remotePromptIds: Record<string, unknown>,
): boolean {
  return activeRequest?.id === item.request.id &&
    activeRuntimeId === item.runtimeId &&
    !remotePromptIds[item.request.id]
}

/** Only the blocking RPC methods shown by the inbox may produce a reply. */
export function pendingPromptResponse(
  method: PiExtensionUiRequest['method'],
  answer: PendingPromptAnswer,
): PendingPromptResponse | null {
  if (method === 'confirm' && 'confirmed' in answer) {
    return { kind: 'confirm', confirmed: answer.confirmed }
  }
  if ((method === 'select' || method === 'input' || method === 'editor') && 'value' in answer) {
    return { kind: 'value', value: answer.value }
  }
  return null
}
