import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readableHint } from './extension-ui-dialog'

test('a plain placeholder is shown as sent', () => {
  assert.equal(readableHint('Type a name'), 'Type a name')
})

test('an object in the placeholder slot becomes its default, not [object Object]', () => {
  // remote-pi's setup wizard calls ui.input(title, { defaultValue }) although the
  // SDK declares that argument as placeholder: string, so this is the real shape.
  assert.equal(readableHint({ defaultValue: 'desktop' }), 'desktop')
  assert.equal(readableHint({ default: 'fallback' }), 'fallback')
})

test('an object with nothing readable yields no hint', () => {
  assert.equal(readableHint({ unrelated: 1 }), '')
  assert.equal(readableHint({}), '')
})

test('missing or unusable hints are empty, never the word Object', () => {
  for (const value of [undefined, null, [], () => 'x', Symbol('s')]) {
    const hint = readableHint(value)
    assert.equal(typeof hint, 'string')
    assert.ok(!hint.includes('object Object'), `leaked: ${hint}`)
  }
})

test('numbers and booleans read as text', () => {
  assert.equal(readableHint(7), '7')
  assert.equal(readableHint(false), 'false')
})
