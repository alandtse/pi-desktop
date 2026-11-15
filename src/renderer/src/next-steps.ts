import {
  NEXT_STEPS_DEVICE_PATH,
  OMP_DEVICE_WRITE_TOOL,
  parseNextStepsToolCall,
  type NextStep,
} from '../../../resources/next-steps'
import { isNextStepsCall, withoutNextStepsCalls } from '../../shared/chat/next-steps'
import type { DisplayMessage } from '../../shared/chat/message-parsing'

export { isNextStepsCall, withoutNextStepsCalls }
type ToolCall = NonNullable<DisplayMessage['toolCalls']>[number]

// The `path` value streamed so far; its closing quote may not have arrived yet.
const PARTIAL_PATH_VALUE = /"path"\s*:\s*"([^"]*)/
// `content` starts like the steps JSON: {"steps" with its quotes escaped.
const STEPS_CONTENT_START = /"content"\s*:\s*"\{\s*\\"steps\\"/

/**
 * For a call whose arguments may still be streaming (partial JSON): it is, or
 * may still turn out to be, a next-steps call. A device write is told apart by
 * its path once the path shows, or by steps-like content before that. A real
 * file write whose start looks the same shows as soon as its path arrives.
 */
export function mayBeNextStepsCall(call: Pick<ToolCall, 'name' | 'arguments'>): boolean {
  if (isNextStepsCall(call)) return true
  if (call.name !== OMP_DEVICE_WRITE_TOOL) return false
  const path = PARTIAL_PATH_VALUE.exec(call.arguments)
  if (path) return path[1].length > 0 && NEXT_STEPS_DEVICE_PATH.startsWith(path[1])
  return STEPS_CONTENT_START.test(call.arguments)
}

/**
 * The steps the agent suggested in the latest turn (after the last user
 * message): the last call whose result did not fail. None once the user
 * sends the next message.
 */
export function latestNextSteps(messages: DisplayMessage[]): NextStep[] {
  const failedCallIds = new Set<string>()
  // Results follow their calls, so walking back meets a failed result first.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user') break
    if (message.role === 'toolResult' && message.isError && message.toolCallId) failedCallIds.add(message.toolCallId)
    const calls = message.role === 'assistant' ? message.toolCalls ?? [] : []
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex--) {
      const call = calls[callIndex]
      if (failedCallIds.has(call.id)) continue
      const steps = parseNextStepsToolCall(call.name, call.arguments)
      if (steps && steps.length > 0) return steps
    }
  }
  return []
}
