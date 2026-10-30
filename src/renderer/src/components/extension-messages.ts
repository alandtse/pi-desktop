/**
 * How an extension message is rendered.
 *
 * An extension message is not prose that happens to look unusual: the extension
 * declares what it is. `pi.sendMessage` carries a `customType` that names the
 * message and an optional `details` payload, and pi persists both, so the renderer
 * does not have to infer anything from the text.
 *
 * This file is that dispatch. A message with a recognised `customType` gets a
 * purpose-built renderer; anything else falls through to the generic block, so an
 * extension nobody has written a renderer for still displays.
 *
 * The rule this replaces was "does the text contain half-block glyphs?" — which
 * mislabels any box art, diff, table or progress bar that happens to draw with
 * `█▀▄`, and gives the pairing message special treatment only by accident.
 */

/** Half-block glyphs, used only by the generic fallback to preserve a QR's leading. */
export const QR_BLOCK_CHARS = /[\u2580\u2584\u2588]/

/** What an extension message needs in order to be drawn. */
export interface ExtensionMessage {
  /** The extension's identifier for this message, e.g. `remote-pi:pair-code`. */
  customType: string
  /** The message body the extension asked to display. */
  content: string
  /** Whatever the extension attached as `details`, if anything. */
  details?: Record<string, unknown>
}

/** A registered renderer. `null` means "I know this type and it needs no panel". */
export type ExtensionRenderer = (message: ExtensionMessage) => 'pairing' | null

/**
 * Registered `customType`s.
 *
 * Keep this small and literal: a renderer earns a place here when a message needs
 * layout the generic block cannot give it. Everything else should not be listed —
 * the fallback is not a penalty, it is the correct default.
 */
const RENDERERS: ReadonlyMap<string, ExtensionRenderer> = new Map([
  // remote-pi's pairing flow (`pi.sendMessage({ customType: 'remote-pi:pair-code',
  // content: <QR + uri>, details: { uri, token, expiresAt, roomId, name } })`).
  // Its QR is 43 characters wide and its URI 114, so the two need different sizes;
  // no single `<pre>` setting can serve both.
  ['remote-pi:pair-code', () => 'pairing'],
])

/** The layout a message should use. */
export type ExtensionLayout = 'pairing' | 'block' | 'inline'

/**
 * Decide a message's layout from the extension's declaration.
 *
 * Registered types win. Unregistered ones fall back to `block` when the body spans
 * several lines (a one-line pill would collapse the whitespace and destroy any
 * preformatted content) and `inline` otherwise.
 */
export function extensionLayout(message: ExtensionMessage): ExtensionLayout {
  const renderer = RENDERERS.get(message.customType)
  if (renderer) {
    const layout = renderer(message)
    if (layout) return layout
  }
  return message.content.includes('\n') ? 'block' : 'inline'
}

/**
 * The copyable `remotepi://` code, taken from the payload when the extension sent
 * one and from the body otherwise, so a panel stays correct even for a record
 * written before `details` existed.
 */
export function pairingUri(message: ExtensionMessage): string | null {
  const fromDetails = message.details?.uri
  if (typeof fromDetails === 'string' && fromDetails.startsWith('remotepi://')) return fromDetails
  const line = message.content.split('\n').find((candidate) => candidate.includes('remotepi://'))
  return line ? line.trim() : null
}

/** When the pair code stops being usable, in epoch ms, if the extension said. */
export function pairingExpiresAt(message: ExtensionMessage): number | null {
  const value = message.details?.expiresAt
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export interface PairingParts {
  /** The prose lines, trimmed, blanks dropped. */
  text: string[]
  /** Only the QR rows, so they can be given exact leading. */
  qr: string[]
  /** The copyable `remotepi://` code, if the message carried one. */
  uri: string | null
  /** When the code expires, if the extension said. */
  expiresAt: number | null
}

/**
 * Split a pairing message into the three things it contains.
 *
 * The QR rows are separated from the prose so they can keep exact leading while
 * the URI wraps: one blanket setting forced a choice between a code too small to
 * scan and a code too wide to read.
 */
export function pairingLines(message: ExtensionMessage): PairingParts {
  const text: string[] = []
  const qr: string[] = []

  for (const line of message.content.split('\n')) {
    if (QR_BLOCK_CHARS.test(line)) qr.push(line)
    else if (line.includes('remotepi://')) continue
    else if (line.trim()) text.push(line.trim())
  }

  return { text, qr, uri: pairingUri(message), expiresAt: pairingExpiresAt(message) }
}

/**
 * The QR is 43 characters wide and every glyph carries two module rows, so at the
 * body size (`text-sm`, 14px) it is about 361px square — the same visual weight as
 * the prose beside it, which is what makes it easy to aim a phone at. It was 6px
 * before, roughly 155px: present, but a patch of dots you had to hunt for.
 */
export const PAIRING_QR_SIZE = 'text-sm'

/**
 * The URI cannot share that size. It is 114 characters, so on one line at 14px it
 * would need about 958px and would scroll sideways inside its own panel, leaving
 * most of the code off screen. At `text-xs` a typical bubble holds it on about two
 * wrapped lines — no harder to read than before, while the code above it is now
 * usable.
 */
export const PAIRING_URI_SIZE = 'text-xs'
