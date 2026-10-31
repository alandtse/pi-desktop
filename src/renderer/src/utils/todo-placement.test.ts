import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MIN_GUTTER_PX, todoPlacement } from './todo-placement'

test('a wide window puts the task list beside the conversation', () => {
  // 1400px centre, 768px column -> 316px of empty space each side.
  assert.deepEqual(todoPlacement(1400, 'normal'), { mode: 'gutter', width: 292 })
})

test('a narrow window stacks it above the transcript as before', () => {
  // 900px centre -> 66px each side. A task subject cannot be read in that.
  assert.deepEqual(todoPlacement(900, 'normal'), { mode: 'inline', width: 0 })
})

test('the full-width column never has a gutter to stand in', () => {
  // The user asked for the conversation to use the whole pane, so there is no
  // side space left; stacking is the only honest answer.
  assert.deepEqual(todoPlacement(2400, 'full'), { mode: 'inline', width: 0 })
})

test('the threshold is the narrowest usable panel, not a guessed breakpoint', () => {
  const justUnder = MIN_GUTTER_PX * 2 + 768 - 1
  const justOver = MIN_GUTTER_PX * 2 + 768
  assert.equal(todoPlacement(justUnder, 'normal').mode, 'inline')
  assert.equal(todoPlacement(justOver, 'normal').mode, 'gutter')
})

test('a shrinking centre pane drops the panel back inline', () => {
  // Opening the side panel or the review pane narrows the chat centre while the
  // window stays wide, which is why the decision measures pixels, not the window.
  assert.equal(todoPlacement(1600, 'normal').mode, 'gutter')
  assert.equal(todoPlacement(900, 'normal').mode, 'inline')
})
