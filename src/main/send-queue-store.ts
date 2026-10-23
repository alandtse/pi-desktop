import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { getGuiDataPath } from './app-data-paths'
import type { QueuedPrompt } from '../shared/ipc-contracts'

/**
 * The send queue, on disk.
 *
 * The queue lives in the renderer because the app, not the engine, decides when
 * a message is sent. That made it die with the window, so a reload or a build
 * swap silently discarded messages the user had already handed over. It is
 * written here instead, per chat, and restored on the next start.
 *
 * Shape on disk: { "<chatKey>": [{ id, text, attachments }, ...] }
 * Path: send-queue.json in the Electron userData directory.
 *
 * Attachments are stored with their inline content so a restored prompt sends
 * exactly what was queued; a file that has since changed on disk is not what the
 * user queued.
 */

const QUEUE_FILE_NAME = 'send-queue.json'

export type QueueStore = Record<string, readonly QueuedPrompt[]>

export class SendQueueManager {
  private path: string
  private cache: QueueStore = {}
  private loaded = false
  /** Serialises writes so a rapid add/remove cannot interleave two saves. */
  private writing: Promise<void> = Promise.resolve()

  constructor() {
    this.path = getGuiDataPath(QUEUE_FILE_NAME)
  }

  async getAll(): Promise<QueueStore> {
    await this.ensureLoaded()
    return { ...this.cache }
  }

  /** Replaces the stored queues with what the renderer holds. */
  async replace(queues: QueueStore): Promise<void> {
    await this.ensureLoaded()
    this.cache = queues
    const run = this.writing.then(() => this.save())
    this.writing = run.catch(() => undefined)
    await run
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.cache = parseStore(parsed as Record<string, unknown>)
      }
    } catch {
      // A missing file is the normal first run; a corrupt one is discarded
      // rather than blocking startup, because a queue is a convenience and not
      // something worth failing a launch over.
      this.cache = {}
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, `${JSON.stringify(this.cache, null, 2)}\n`, 'utf8')
  }
}

/**
 * Reads the file defensively: a queue restored from an older build must not be
 * able to put a malformed entry into the composer.
 */
function parseStore(raw: Record<string, unknown>): QueueStore {
  const store: QueueStore = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue
    const prompts = value.flatMap((entry): QueuedPrompt[] => {
      if (entry === null || typeof entry !== 'object') return []
      const prompt = entry as Partial<QueuedPrompt>
      if (typeof prompt.id !== 'string' || typeof prompt.text !== 'string') return []
      return [{ id: prompt.id, text: prompt.text, attachments: prompt.attachments ?? [] }]
    })
    if (prompts.length > 0) store[key] = prompts
  }
  return store
}
