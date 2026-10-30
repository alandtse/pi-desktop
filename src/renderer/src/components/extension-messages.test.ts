import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PAIRING_QR_SIZE,
  PAIRING_URI_SIZE,
  extensionLayout,
  pairingExpiresAt,
  pairingLines,
  pairingUri,
  readMeshMessage,
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

test('a mesh message is labelled with who sent it', () => {
  // remote-pi writes this header itself (dist/index.js:3719), so the sender is read
  // from its text rather than assumed.
  // Paths are written twice-escaped because remote-pi sends a Windows path in the
  // header and a single backslash in a JS string literal would be eaten as an escape.
  const fromAddress = 'E:\\Documents\\source\\repos\\open-shaders@open-shaders'
  const message = {
    customType: 'remote-pi:mesh-message',
    content: [
      `[agent-network] message from "${fromAddress}" (id=01a18b75-5919, re=01a18b7a-abcd):`,
      'Body line one.',
      '',
      'Body line two.',
      '',
      '(This is a reply to a previous message of yours.)',
    ].join('\n'),
  }

  assert.equal(extensionLayout(message), 'mesh', 'it gets its own panel, not a generic block')

  const read = readMeshMessage(message)
  assert.equal(read.from, fromAddress)
  assert.equal(read.id, '01a18b75-5919')
  assert.equal(read.re, '01a18b7a-abcd')
  assert.equal(read.body.includes('Body line one.'), true, 'the body survives the header strip')
})

test('a mesh header without an id still names the sender', () => {
  const read = readMeshMessage({
    customType: 'remote-pi:mesh-message',
    content: '[agent-network] message from "desktop#3":\nhello',
  })
  assert.equal(read.from, 'desktop#3')
  assert.equal(read.id, null)
  assert.equal(read.re, null)
})

test('unparseable content still shows the whole message', () => {
  // Better an unlabelled body than an empty panel: an older or newer remote-pi may
  // write a header this does not recognise.
  const read = readMeshMessage({ customType: 'remote-pi:mesh-message', content: 'just some text' })
  assert.equal(read.from, '')
  assert.equal(read.body, 'just some text')
})
