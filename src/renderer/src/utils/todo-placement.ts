import type { ChatWidth } from '../../../shared/chat-width'
import { messageColumnMaxPx } from './chat-width'

/**
 * Where the task list belongs.
 *
 * The conversation is a centred column (`max-w-3xl` in Normal width), so on a wide
 * window there is empty space either side of it. The panel used to be stacked above
 * the transcript at full chat-centre width, which pushed the conversation down and
 * put a wide band of chrome across the middle of the screen. That same space, taken
 * from the side, costs the transcript nothing: it is already unused.
 *
 * Below the threshold there is no gutter worth using — at 900px the side space is
 * ~66px each, too narrow for a task subject — so the panel stays above the transcript
 * exactly as before. The mode is decided from measured pixels rather than a breakpoint
 * class because the chat centre is sized by the grid, not by the window: the side panel,
 * the review pane and a stacked terminal all shrink it while the window stays wide.
 */
export const MIN_GUTTER_PX = 200

/** Horizontal padding the panel already has on each side. */
const GUTTER_PADDING_PX = 12

export interface TodoPlacement {
  mode: 'gutter' | 'inline'
  /** Panel width in pixels when in the gutter; unused inline, where it fills the column. */
  width: number
}

/**
 * `centreWidth` is the measured width of the chat centre; `chatWidth` is the user's
 * column preference. A `full` column has no gutter by definition, so it always stacks.
 */
export function todoPlacement(centreWidth: number, chatWidth: ChatWidth): TodoPlacement {
  const column = Math.min(messageColumnMaxPx(chatWidth), centreWidth)
  const side = Math.floor((centreWidth - column) / 2)
  if (side < MIN_GUTTER_PX) return { mode: 'inline', width: 0 }
  return { mode: 'gutter', width: side - GUTTER_PADDING_PX * 2 }
}
