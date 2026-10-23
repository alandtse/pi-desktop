import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SendQueueManager } from './send-queue-store'

// The store resolves its file through the GUI data dir, so the test points that
// at a scratch directory rather than writing into the real user profile.
process.env.PI_DESKTOP_USER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pi-desktop-queue-'))

const queueFile = (): string => join(process.env.PI_DESKTOP_USER_DATA_DIR as string, 'send-queue.json')

test('a queue written by one run is there for the next', async () => {
  const manager = new SendQueueManager()
  await manager.replace({
    'local:/sessions/a.jsonl': [{ id: 'a1', text: 'first', attachments: [] }],
  })
  const restored = await new SendQueueManager().getAll()
  assert.deepEqual(restored, { 'local:/sessions/a.jsonl': [{ id: 'a1', text: 'first', attachments: [] }] })
})

test('attachments survive with their content', async () => {
  const manager = new SendQueueManager()
  await manager.replace({
    'local:/sessions/b.jsonl': [{
      id: 'b1',
      text: 'look at this',
      attachments: [{ kind: 'text', name: 'notes.md', path: '/tmp/notes.md', content: '# notes' }],
    }],
  })
  const restored = await new SendQueueManager().getAll()
  assert.equal(restored['local:/sessions/b.jsonl'][0].attachments[0].kind, 'text')
  assert.equal(restored['local:/sessions/b.jsonl'][0].attachments[0].name, 'notes.md')
})

test('a corrupt file is discarded instead of failing startup', async () => {
  writeFileSync(queueFile(), '{ not json')
  assert.deepEqual(await new SendQueueManager().getAll(), {})
})

test('a malformed entry is dropped rather than reaching the composer', async () => {
  writeFileSync(queueFile(), JSON.stringify({
    'local:/sessions/c.jsonl': [{ id: 'ok', text: 'keep me', attachments: [] }, { id: 7, text: null }],
    'local:/sessions/d.jsonl': 'not an array',
  }))
  const restored = await new SendQueueManager().getAll()
  assert.deepEqual(Object.keys(restored), ['local:/sessions/c.jsonl'])
  assert.deepEqual(restored['local:/sessions/c.jsonl'].map((prompt) => prompt.id), ['ok'])
})

test('the file is readable JSON with a trailing newline', async () => {
  const manager = new SendQueueManager()
  await manager.replace({ 'remote:peer:room': [{ id: 'r1', text: 'hi', attachments: [] }] })
  const raw = readFileSync(queueFile(), 'utf8')
  assert.ok(raw.endsWith('\n'))
  assert.deepEqual(JSON.parse(raw), { 'remote:peer:room': [{ id: 'r1', text: 'hi', attachments: [] }] })
})
