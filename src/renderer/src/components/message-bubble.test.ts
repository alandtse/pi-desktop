import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { isImeComposing } from '../utils/ime-composing'

const source = ts.createSourceFile(
  'message-bubble.tsx',
  readFileSync(new URL('./message-bubble.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
)

function editKeyHandler(): string {
  let handler: string | undefined
  function visit(node: ts.Node): void {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'textarea') {
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'onKeyDown' &&
            attribute.initializer && ts.isJsxExpression(attribute.initializer)) {
          handler = attribute.initializer.expression?.getText(source)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(handler, 'The message editor must handle keyboard submission')
  return handler
}

for (const scenario of [
  { name: 'Enter sends the edit', key: 'Enter', shiftKey: false, nativeEvent: {}, sends: true },
  { name: 'Shift+Enter preserves a newline', key: 'Enter', shiftKey: true, nativeEvent: {}, sends: false },
  { name: 'Other keys do not send', key: 'a', shiftKey: false, nativeEvent: {}, sends: false },
  { name: 'IME confirmation does not send', key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true }, sends: false },
  { name: 'IME processing does not send', key: 'Enter', shiftKey: false, nativeEvent: { keyCode: 229 }, sends: false },
]) {
  test(scenario.name, () => {
    let sends = 0
    let prevented = false
    let stopped = false
    const handler = new Function('isImeComposing', 'onSaveEdit', `return (${editKeyHandler()})`)(
      isImeComposing,
      () => { sends++ },
    )
    handler({
      ...scenario,
      preventDefault: () => { prevented = true },
      stopPropagation: () => { stopped = true },
    })
    assert.equal(sends, scenario.sends ? 1 : 0)
    assert.equal(prevented, scenario.sends)
    assert.equal(stopped, scenario.sends)
  })
}

test('a pairing block sizes the QR for scanning and wraps the long code', async () => {
  const { PAIRING_QR_SIZE, PAIRING_URI_SIZE, pairingLines } = await import('./pairing-block')

  // Geometry from remote-pi's own renderer: the QR is 43 characters wide and 22
  // rows tall, each glyph carrying two module rows. The URI is 114 characters.
  const qrRow = [0x2588, 0x20, 0x2584, 0x2584, 0x2584, 0x2584, 0x2584, 0x20, 0x2588]
    .map((code) => String.fromCharCode(code))
    .join('')
  const content = [
    'Scan to pair:',
    '',
    qrRow,
    '',
    'Or copy this pairing code (camera-less devices):',
    '',
    'remotepi://pair?t=rbIk5xfuLxvyXlwzqhY6YA&epk=abc&n=desktop&rm=9NsvFIsyNlTH',
  ].join('\n')

  const parts = pairingLines(content)
  assert.equal(parts.qr.length, 1, 'every half-block row goes to the code')
  assert.equal(parts.uri?.startsWith('remotepi://pair?'), true, 'the code is split out of the prose')
  assert.deepEqual(parts.text, ['Scan to pair:', 'Or copy this pairing code (camera-less devices):'])

  // The QR must be at body size. At 6px it was about 155px wide: present, but a
  // phone had to be held steady over a patch of tiny dots to catch it.
  assert.equal(PAIRING_QR_SIZE, 'text-sm', 'the code is set at the body text size, so it can be aimed at')
  // The URI CANNOT be. At 14px its 114 characters need about 958px on one line
  // and would scroll sideways off the panel; it wraps at the supporting-text size.
  assert.equal(PAIRING_URI_SIZE, 'text-xs', 'the long code wraps instead of scrolling away')
})
