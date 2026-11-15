import { parseNextStepsToolCall } from '../../../resources/next-steps'
import type { DisplayMessage } from './message-parsing'

type ToolCall = NonNullable<DisplayMessage['toolCalls']>[number]

/** The call suggests next steps; the chat shows its steps as buttons, never as a tool call. */
export function isNextStepsCall(call: Pick<ToolCall, 'name' | 'arguments'>): boolean {
  return parseNextStepsToolCall(call.name, call.arguments) !== null
}

/**
 * The messages without next-steps calls and their results. A message that
 * held only such a call is dropped. The same list comes back when nothing
 * was hidden, so memoized rows stay stable.
 */
export function withoutNextStepsCalls(messages: DisplayMessage[]): DisplayMessage[] {
  const hiddenCallIds = new Set<string>()
  const visible: DisplayMessage[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls?.some(isNextStepsCall)) {
      const toolCalls = message.toolCalls.filter((call) => {
        if (!isNextStepsCall(call)) return true
        hiddenCallIds.add(call.id)
        return false
      })
      if (toolCalls.length === 0 && !message.content.trim() && !message.thinking) continue
      visible.push({ ...message, toolCalls: toolCalls.length > 0 ? toolCalls : undefined })
    } else if (!(message.role === 'toolResult' && message.toolCallId && hiddenCallIds.has(message.toolCallId))) {
      visible.push(message)
    }
  }
  return hiddenCallIds.size > 0 ? visible : messages
}
