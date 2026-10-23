import { ipcMain } from 'electron'
import { IPC_CHANNELS, type QueuedPrompt } from '../../shared/ipc-contracts'
import { SendQueueManager } from '../send-queue-store'
import { appLog } from '../app-log'

/** Chat key to the prompts queued for it, oldest first. */
export type StoredSendQueues = Record<string, readonly QueuedPrompt[]>

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Persists the send queue so a restart or a build swap does not discard messages
 * the user already handed over.
 *
 * The queue stays owned by the renderer — it decides when a message is sent —
 * and this only mirrors it to disk. Writes are whole-file: the queue is small
 * and a partial update would let two windows disagree about what is pending.
 */
export function registerSendQueueHandlers(): void {
  const manager = new SendQueueManager()

  ipcMain.handle(IPC_CHANNELS.SEND_QUEUE_LOAD, async () => {
    return manager.getAll()
  })

  ipcMain.handle(IPC_CHANNELS.SEND_QUEUE_SAVE, async (_event, queues: unknown) => {
    if (!isObject(queues)) throw new Error('send queues must be an object')
    try {
      await manager.replace(queues as StoredSendQueues)
    } catch (err) {
      // A queue that cannot be written must not break the turn that is running;
      // the renderer keeps its in-memory copy either way.
      appLog.error('send-queue', 'Failed to save the send queue', err)
      throw err
    }
  })
}
