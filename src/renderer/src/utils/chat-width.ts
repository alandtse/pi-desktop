import type { ChatWidth } from '../../../shared/chat-width'

// Tailwind finds classes by scanning the source text, so every class is
// written out in full here instead of being built from parts.

/**
 * One column width for messages, the composer, the panels above it, and the
 * empty-chat prompt. Normal is a readable column; Full uses the whole pane.
 */
const MESSAGE_COLUMN_CLASS: Record<ChatWidth, string> = {
  normal: 'max-w-3xl',
  full: 'max-w-none',
}

export function messageColumnClass(width: ChatWidth): string {
  return MESSAGE_COLUMN_CLASS[width]
}

/**
 * The centred conversation column as pixels, so a caller can reason about the space
 * beside it. Mirrors the same two classes `messageColumnClass` writes — keeping them in
 * one file is what stops a width change from silently desyncing the gutter decision.
 */
const MESSAGE_COLUMN_MAX_PX: Record<ChatWidth, number> = {
  normal: 768,
  full: Number.POSITIVE_INFINITY,
}

export function messageColumnMaxPx(width: ChatWidth): number {
  return MESSAGE_COLUMN_MAX_PX[width]
}
