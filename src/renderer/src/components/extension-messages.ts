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
export type ExtensionRenderer = (message: ExtensionMessage) => 'pairing' | 'mesh' | null

/**
 * Registered `customType`s.
 *
 * Keep this small and literal: a renderer earns a place here when a message needs
 * layout the generic block cannot give it. Everything else should not be listed —
 * the fallback is not a penalty, it is the correct default.
 */
const RENDERERS: ReadonlyMap<string, ExtensionRenderer> = new Map<string, ExtensionRenderer>([
  // remote-pi's pairing flow (`pi.sendMessage({ customType: 'remote-pi:pair-code',
  // content: <QR + uri>, details: { uri, token, expiresAt, roomId, name } })`).
  // Its QR is 43 characters wide and its URI 114, so the two need different sizes;
  // no single `<pre>` setting can serve both.
  ['remote-pi:pair-code', () => 'pairing'],
  // remote-pi delivers an inbound agent-network message as a persisted custom message
  // (`_meshMessageForAgent`, dist/index.js:3719) whose header names the sender:
  //   [agent-network] message from "<address>" (id=..., re=...):
  // The same message is ALSO broadcast live as a `tool_request` with tool
  // `agent-network`. Both used to land wherever the window was pointed without saying
  // who sent them; the header is the sender, and it is all either shape carries — the
  // wire envelope has no recipient field, so naming an addressee would be inventing one.
  ['remote-pi:mesh-message', () => 'mesh'],
])

/** The layout a message should use. */
export type ExtensionLayout = 'pairing' | 'mesh' | 'block' | 'inline'

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

/** Who a mesh message came FROM. The wire carries no recipient, so that is all we can say. */
export interface MeshMessage {
  from: string
  body: string
  id: string | null
  re: string | null
}

/**
 * Read a mesh message out of remote-pi's own header line.
 *
 * The header is the only place the sender appears in the persisted message, and it is
 * written by remote-pi rather than by us, so the parse is deliberately tolerant: a
 * header that does not match still yields the whole body with `from` empty, which is
 * more useful than an unlabelled wall of text.
 */
export function readMeshMessage(message: ExtensionMessage): MeshMessage {
  const lines = message.content.split('\n')
  const header = /^\[agent-network\] message from "(.*?)"(?: \(id=([^,)]+)(?:, re=([^)]+))?\))?:?$/
  const match = lines.length > 0 ? header.exec(lines[0].trim()) : null
  if (!match) return { from: '', body: message.content.trim(), id: null, re: null }
  return {
    from: match[1] ?? '',
    body: lines.slice(1).join('\n').trim(),
    id: match[2] ?? null,
    re: match[3] ?? null,
  }
}
