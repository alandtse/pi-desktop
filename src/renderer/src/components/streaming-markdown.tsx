import { useEffect, useRef, useState } from 'react'
import { MarkdownRenderer } from './markdown-renderer'
import { STREAM_RENDER_INTERVAL_MS } from '../stream-throttle'

export { STREAM_RENDER_INTERVAL_MS }

/**
 * A streaming answer, re-parsed no more often than `intervalMs`.
 *
 * Leading edge: a delta arriving after an idle gap renders at once, so the first
 * words of a reply are not delayed. Trailing edge: deltas during the interval are
 * coalesced into one parse when it expires, so the last chunk is never dropped.
 */
export function StreamingMarkdown({
  content,
  intervalMs = STREAM_RENDER_INTERVAL_MS,
}: {
  content: string
  intervalMs?: number
}): React.JSX.Element {
  // The text the last parse used. Rendering this instead of `content` is the
  // throttle: React sees a new value at most once per interval.
  const [rendered, setRendered] = useState(content)
  const lastRenderAt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(content)
  latest.current = content

  useEffect(() => {
    const now = Date.now()
    const elapsed = now - lastRenderAt.current
    // Leading edge: an idle gap means nothing is in flight, so this text is current.
    if (elapsed >= intervalMs) {
      lastRenderAt.current = now
      setRendered(content)
      return
    }
    // A timeout is already scheduled and reads `latest`, so this delta is deferred
    // rather than lost.
    if (timer.current !== null) return
    timer.current = setTimeout(() => {
      timer.current = null
      lastRenderAt.current = Date.now()
      setRendered(latest.current)
    }, intervalMs - elapsed)
  }, [content, intervalMs])

  // A settled message unmounts this bubble, but a turn can end while a timer is
  // pending; clearing it keeps a stray setState off an unmounted component.
  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  return <MarkdownRenderer content={rendered} />
}
