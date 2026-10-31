/**
 * How much of the agent's task list the GUI shows.
 *
 * The list is context for reading a conversation, not a thing the user operates, so
 * it must be possible to get it off the screen entirely — before this it was always
 * drawn and the only control was its own collapse chevron, which still left a line of
 * chrome above the transcript.
 */
export type TodoPlacementMode = 'auto' | 'inline' | 'hidden'

export const TODO_PLACEMENT_MODES: readonly TodoPlacementMode[] = ['auto', 'inline', 'hidden']

export const DEFAULT_TODO_PLACEMENT: TodoPlacementMode = 'auto'

export function isTodoPlacementMode(value: unknown): value is TodoPlacementMode {
  return typeof value === 'string' && (TODO_PLACEMENT_MODES as readonly string[]).includes(value)
}
