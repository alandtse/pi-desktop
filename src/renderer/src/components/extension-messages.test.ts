import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PAIRING_QR_SIZE,
  PAIRING_URI_SIZE,
  extensionLayout,
  pairingExpiresAt,
  pairingLines,
  pairingUri,
} from './extension-messages'

// remote-pi draws its QR with half-block glyphs, 43 characters wide and 22 rows
// tall, each glyph carrying two module rows.
const BLOCK = [0x2588, 0x20, 0x2584, 0x2584, 0x2584, 0x2584, 0x2584, 0x20, 0x2588]
  .map((code) => String.fromCharCode(code))
  .join('')
const URI = 'remotepi://pair?t=rbIk5xfuLxvyXlwzqhY6YA&epk=abc&n=desktop&rm=9NsvFIsyNlTH'

const PAIR_CONTENT = [
  '📱 Scan to pair:',
  '',
  BLOCK,
  '',
  '📋 Or copy this pairing code (camera-less devices):',
  '',
  URI,
].join('\n')

test('the pairing message is chosen by its declared type', () => {
  const message = {
    customType: 'remote-pi:pair-code',
    content: PAIR_CONTENT,
    details: { uri: URI, expiresAt: 1793260000000, roomId: '9NsvFIsyNlTH' },
  }

  assert.equal(extensionLayout(message), 'pairing')

  const parts = pairingLines(message)
  assert.equal(parts.qr.length, 1, 'every half-block row goes to the code')
  assert.deepEqual(parts.text, [
    '📱 Scan to pair:',
    '📋 Or copy this pairing code (camera-less devices):',
  ])
  assert.equal(parts.uri, URI, 'the code comes from the payload the extension sent')
  assert.equal(parts.expiresAt, 1793260000000)
})

test('box art from an unregistered extension is not treated as a pairing code', () => {
  // The rule this replaced was "does the text contain half-block glyphs?", which
  // gave every progress bar, diff and table a QR's layout. A message is what the
  // extension says it is.
  const message = {
    customType: 'someone-else:progress',
    content: ['Building…', BLOCK].join('\n'),
  }

  assert.equal(extensionLayout(message), 'block', 'it gets the generic panel, not the pairing one')
})

test('an unregistered one-line message stays inline', () => {
  assert.equal(
    extensionLayout({ customType: 'someone-else:notice', content: 'Saved.' }),
    'inline',
  )
  // A message with no type at all cannot be matched, so it behaves like any other.
  assert.equal(extensionLayout({ customType: '', content: 'Saved.' }), 'inline')
})

test('the copyable code falls back to the body for records written before details', () => {
  // Session files predating `details` still carry the URI on its own line, and a
  // panel that shows no code is worse than one that reads it from the text.
  const older = { customType: 'remote-pi:pair-code', content: PAIR_CONTENT }
  assert.equal(pairingUri(older), URI)
  assert.equal(pairingExpiresAt(older), null, 'an old record states no expiry rather than inventing one')

  // The payload wins when both are present: it is what the extension meant.
  const explicit = { ...older, details: { uri: 'remotepi://pair?t=other' } }
  assert.equal(pairingUri(explicit), 'remotepi://pair?t=other')

  // Anything that is not a pair code is not offered as one.
  assert.equal(pairingUri({ customType: '', content: 'no code here' }), null)
})

test('the QR is sized to be scanned and the long code to be read', () => {
  // 43 characters at 14px is about 361px square — the same weight as the prose
  // beside it. At 6px it was ~155px: a patch of dots a phone had to be held
  // steady over.
  assert.equal(PAIRING_QR_SIZE, 'text-sm')
  // The URI is 114 characters, so on one line at 14px it would need ~958px and
  // would scroll sideways off its own panel. It wraps at the supporting size.
  assert.equal(PAIRING_URI_SIZE, 'text-xs')
})
