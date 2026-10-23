import type { DisplayMessage } from './message-parsing'

/** Same cap the composer's recall list used before it became per-tab. */
export const PROMPT_HISTORY_LIMIT = 200

/**
 * The prompts the user typed in this chat, oldest first.
 *
 * Derived from the transcript rather than kept in a separate list, because the
 * Pi already writes every prompt to the session file: a derived history is
 * correct after a restart, after switching away and back, and for a session
 * opened cold — all cases a renderer-only list got wrong. Only real user turns
 * count (a system notice is not something you typed), and consecutive
 * duplicates collapse the way a shell's history does.
 */
export function promptHistoryFrom(messages: readonly DisplayMessage[]): string[] {
  const history: string[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = message.content.trim()
    if (!text) continue
    if (history[history.length - 1] === text) continue
    history.push(text)
  }
  return history.length > PROMPT_HISTORY_LIMIT
    ? history.slice(history.length - PROMPT_HISTORY_LIMIT)
    : history
}
