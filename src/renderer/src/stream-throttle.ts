/**
 * How often streamed text is allowed to be re-parsed as markdown, in milliseconds.
 *
 * Rendering the live answer through the markdown pipeline on every token event costs
 * the square of its length: a 21 KB reply arrives as ~1800 deltas, and parsing the
 * whole accumulated text at each one measured 17 s of synchronous work for a single
 * answer. That work is on the main thread, which is why a long reply marks the window
 * Not Responding instead of drawing as it arrives.
 *
 * 100 ms keeps the text reading as though it streams while cutting the parse count by
 * an order of magnitude, and it is below what reads as lag next to an arriving reply.
 *
 * Plain module (not .tsx) so the test can import it without a DOM renderer.
 */
export const STREAM_RENDER_INTERVAL_MS = 100

/**
 * How many markdown parses a streamed reply costs, given its delta count and the
 * average delay between deltas. The unthrottled cost is one parse per delta; this is
 * the number the throttle brings it to.
 *
 * Two bounds apply and the tighter one wins. Time-based: at most one parse per
 * interval of turn duration. Count-based: a delta never costs more than one parse, so
 * a stream slower than the interval pays its own delta count — the throttle must not
 * silently drop content from a slow model.
 */
export function parsesForStream(
  deltaCount: number,
  msPerDelta: number,
  intervalMs = STREAM_RENDER_INTERVAL_MS
): number {
  if (deltaCount <= 0) return 0
  const byTime = Math.ceil((deltaCount * msPerDelta) / intervalMs) + 1
  const byCount = deltaCount + 1
  return Math.min(byTime, byCount)
}
