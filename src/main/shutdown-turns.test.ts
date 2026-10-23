// The record a quit leaves behind is what makes "was this interrupted?" a fact.
//
// A record that cannot be read must read as "nothing was running", because
// continuing a turn nobody asked for is worse than not continuing one that was
// wanted. A record that is never cleared would offer the same continuation on
// every later start.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  clearShutdownTurns,
  readShutdownTurns,
  shouldContinueFromMarker,
  shutdownTurnsPath,
  writeShutdownTurns,
} from './shutdown-turns'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'shutdown-turns-'))
}

test('a record names the chats that were working and no others', async () => {
  const dir = await tempDir()
  await writeShutdownTurns(dir, { recordedAt: 'now', midTurn: { '/s/a.jsonl': 't1', '/s/b.jsonl': 't2' } })

  const record = await readShutdownTurns(dir)
  assert.ok(record)
  assert.equal(shouldContinueFromMarker(record, '/s/a.jsonl'), true)
  assert.equal(shouldContinueFromMarker(record, '/s/b.jsonl'), true)
  assert.equal(shouldContinueFromMarker(record, '/s/other.jsonl'), false)
  await rm(dir, { recursive: true, force: true })
})

test('no record at all continues nothing', async () => {
  const dir = await tempDir()
  assert.equal(await readShutdownTurns(dir), null)
  assert.equal(shouldContinueFromMarker(null, '/s/a.jsonl'), false)
  await rm(dir, { recursive: true, force: true })
})

test('a corrupt or foreign record continues nothing', async () => {
  const dir = await tempDir()
  await writeFile(shutdownTurnsPath(dir), 'not json', 'utf-8')
  assert.equal(await readShutdownTurns(dir), null)

  // A record from a future version may mean something else entirely.
  await writeFile(shutdownTurnsPath(dir), JSON.stringify({ version: 999, recordedAt: 'now', midTurn: { '/s/a.jsonl': 't' } }), 'utf-8')
  assert.equal(await readShutdownTurns(dir), null)
  await rm(dir, { recursive: true, force: true })
})

test('clearing the record stops it being offered again', async () => {
  const dir = await tempDir()
  await writeShutdownTurns(dir, { recordedAt: 'now', midTurn: { '/s/a.jsonl': 't1' } })
  await clearShutdownTurns(dir)

  const record = await readShutdownTurns(dir)
  assert.equal(shouldContinueFromMarker(record, '/s/a.jsonl'), false)
  await rm(dir, { recursive: true, force: true })
})

test('a write leaves no partial file behind for a reader to trip over', async () => {
  const dir = await tempDir()
  await writeShutdownTurns(dir, { recordedAt: 'now', midTurn: { '/s/a.jsonl': 't1' } })
  // The temp sibling the atomic write uses must be gone once the rename lands.
  const text = await readFile(shutdownTurnsPath(dir), 'utf-8')
  assert.match(text, /"midTurn"/)
  await assert.rejects(readFile(`${shutdownTurnsPath(dir)}.tmp`, 'utf-8'))
  await rm(dir, { recursive: true, force: true })
})
