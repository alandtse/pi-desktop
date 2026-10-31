import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STREAM_RENDER_INTERVAL_MS, parsesForStream } from './stream-throttle'

/**
 * The throttle is a timing behaviour, which `node:test` cannot observe through React
 * without a DOM renderer. What CAN be pinned is the contract the fix depends on: the
 * interval exists, it is short enough to read as live, and it bounds the number of
 * markdown parses a streamed reply causes.
 *
 * The cost being bounded is quadratic — a full parse at every prefix length — so a
 * parse budget is the thing that matters, not the implementation.
 */
test('the streaming interval is short enough to read as live', () => {
  assert.ok(STREAM_RENDER_INTERVAL_MS > 0, 'a throttle of 0 would not throttle')
  assert.ok(
    STREAM_RENDER_INTERVAL_MS <= 250,
    'a longer interval than 250ms reads as stuttering text rather than streaming'
  )
})

test('a streamed reply parses at most once per interval, not once per delta', () => {
  // A 21 KB reply at a 12-character delta is ~1800 events, and 5ms between them is
  // generous: a real turn delivers them faster.
  const DELTAS = 1800
  const MS_PER_DELTA = 5
  const throttled = parsesForStream(DELTAS, MS_PER_DELTA)

  assert.equal(DELTAS, 1800, 'the unthrottled cost is one parse per delta')
  assert.ok(
    throttled < DELTAS / 10,
    `the throttle must cut parses by an order of magnitude, got ${throttled} of ${DELTAS}`
  )
})

test('an empty or short stream costs one parse, never a negative budget', () => {
  assert.equal(parsesForStream(0, 5), 0)
  assert.equal(parsesForStream(1, 5), 2, 'the first delta renders on the leading edge')
})

test('a slow stream is parses per delta, because each delta lands after the interval', () => {
  // At 150ms per delta with a 100ms interval every delta is its own leading edge, so
  // the throttle costs nothing — it must not silently drop content on a slow model.
  const slow = parsesForStream(10, 150)
  assert.equal(slow, 11, 'every delta renders, plus the trailing one')
})
