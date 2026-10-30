/**
 * Sizing and splitting for the pairing message remote-pi sends: a sentence, a QR
 * drawn in half-block characters, and a long `remotepi://` code.
 *
 * Kept out of the component so it can be tested without a DOM — the pairing block
 * is the one system message whose geometry matters, and geometry is the kind of
 * thing that silently regresses when nobody measures it.
 */

/** Half-block glyphs: how a QR is drawn in text. */
export const QR_BLOCK_CHARS = /[\u2580\u2584\u2588]/

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

export interface PairingParts {
  /** The prose lines, trimmed, blanks dropped. */
  text: string[]
  /** Only the QR rows, so they can be given exact leading. */
  qr: string[]
  /** The copyable `remotepi://` code, if the message carried one. */
  uri: string | null
}

/**
 * Separate the three kinds of line. One blanket `<pre>` forced a choice between a
 * QR too small to scan and a URI too wide to read; splitting them lets each line
 * get the treatment it needs.
 */
export function pairingLines(content: string): PairingParts {
  const text: string[] = []
  const qr: string[] = []
  let uri: string | null = null

  for (const line of content.split('\n')) {
    if (QR_BLOCK_CHARS.test(line)) qr.push(line)
    else if (/remotepi:\/\//.test(line)) uri = line.trim()
    else if (line.trim()) text.push(line.trim())
  }

  return { text, qr, uri }
}

/** Whether this message is a pairing block, which is what asks for the QR layout. */
export function isPairingBlock(content: string): boolean {
  return QR_BLOCK_CHARS.test(content)
}
