// The record a stopped run leaves is what makes "was this interrupted?" a fact.
//
// Two defects in the older design are pinned here as tests, because both were
// invisible on Windows: one record whose timestamp was rewritten on every turn
// change could not say which run wrote it (so an old chat could restart), and
// clearing the whole file on the first ask starved every other interrupted chat.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  LEGACY_RUN_ID,
  claimFor,
  readShutdownTurns,
  shouldContinueFromMarker,
  shutdownTurnsPath,
  writeShutdownTurns,
} from './shutdown-turns'
import type { ShutdownTurns, TurnClaim } from './shutdown-turns'

const RUN_A = 'run-a'
const RUN_B = 'run-b'

function claim(runId: string): TurnClaim {
  return { runId, pid: 1234, startedAt: '2026-10-29T00:00:00.000Z', lastSeenAt: '2026-10-29T00:01:00.000Z' }
}

function recordOf(runId: string, paths: string[], owner = runId): ShutdownTurns {
  const midTurn: Record<string, TurnClaim> = {}
  for (const path of paths) midTurn[path] = claim(owner)
  return { runId, recordedAt: '2026-10-29T00:02:00.000Z', cleanExit: false, midTurn }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'shutdown-turns-'))
}

test('a record names the chats that were working and no others', async () => {
  const dir = await tempDir()
  await writeShutdownTurns(dir, recordOf(RUN_A, ['/s/a.jsonl', '/s/b.jsonl']))

  const record = await readShutdownTurns(dir)
  assert.ok(record)
  assert.equal(shouldContinueFromMarker(record, '/s/a.jsonl', RUN_B), true)
  assert.equal(shouldContinueFromMarker(record, '/s/b.jsonl', RUN_B), true)
  assert.equal(shouldContinueFromMarker(record, '/s/other.jsonl', RUN_B), false)
  await rm(dir, { recursive: true, force: true })
})

test('a claim written by this run is not an interruption', async () => {
  const dir = await tempDir()
  await writeShutdownTurns(dir, recordOf(RUN_A, ['/s/a.jsonl']))

  const record = await readShutdownTurns(dir)
  // The same run that recorded it is still holding that turn open, so continuing
  // it would send a prompt into a conversation that is already working. This is
  // the "old session restarts for no reason" case.
  assert.equal(shouldContinueFromMarker(record, '/s/a.jsonl', RUN_A), false)
  assert.equal(claimFor(record, '/s/a.jsonl', RUN_A), null)
  assert.equal(shouldContinueFromMarker(record, '/s/a.jsonl', RUN_B), true)
  await rm(dir, { recursive: true, force: true })
})

test('a clean exit still leaves its claims worth continuing', async () => {
  const dir = await tempDir()
  await writeShutdownTurns(dir, { ...recordOf(RUN_A, ['/s/a.jsonl']), cleanExit: true })

  const record = await readShutdownTurns(dir)
  assert.ok(record)
  assert.equal(record.cleanExit, true)
  // cleanExit says how the run ended, not whether the turn finished. A turn open
  // at a clean quit was still cut short.
  assert.equal(shouldContinueFromMarker(record, '/s/a.jsonl', RUN_B), true)
  await rm(dir, { recursive: true, force: true })
})

test('no record at all continues nothing', async () => {
  const dir = await tempDir()
  assert.equal(await readShutdownTurns(dir), null)
  assert.equal(shouldContinueFromMarker(null, '/s/a.jsonl', RUN_B), false)
  assert.equal(claimFor(null, '/s/a.jsonl', RUN_B), null)
  await rm(dir, { recursive: true, force: true })
})

test('a corrupt or foreign record continues nothing', async () => {
  const dir = await tempDir()
  await writeFile(shutdownTurnsPath(dir), 'not json', 'utf-8')
  assert.equal(await readShutdownTurns(dir), null)

  // A record from a future version may mean something else entirely.
  await writeFile(
    shutdownTurnsPath(dir),
    JSON.stringify({ version: 999, runId: RUN_A, recordedAt: 'now', midTurn: { '/s/a.jsonl': claim(RUN_A) } }),
    'utf-8',
  )
  assert.equal(await readShutdownTurns(dir), null)

  // A version nobody knows may mean something else entirely.
  await writeFile(
    shutdownTurnsPath(dir),
    JSON.stringify({ version: 424242, runId: RUN_A, recordedAt: 'now', midTurn: { '/s/a.jsonl': claim(RUN_A) } }),
    'utf-8',
  )
  assert.equal(await readShutdownTurns(dir), null)
  await rm(dir, { recursive: true, force: true })
})

test('a claim missing its run identity is dropped, not guessed at', async () => {
  const dir = await tempDir()
  await writeShutdownTurns(dir, recordOf(RUN_A, ['/s/a.jsonl', '/s/b.jsonl']))
  const text = await readFile(shutdownTurnsPath(dir), 'utf-8')
  const parsed = JSON.parse(text) as { midTurn: Record<string, unknown> }
  parsed.midTurn['/s/b.jsonl'] = { pid: 1234, startedAt: 'x', lastSeenAt: 'x' }
  await writeFile(shutdownTurnsPath(dir), JSON.stringify(parsed), 'utf-8')

  const record = await readShutdownTurns(dir)
  assert.ok(record)
  assert.equal(shouldContinueFromMarker(record, '/s/a.jsonl', RUN_B), true)
  assert.equal(shouldContinueFromMarker(record, '/s/b.jsonl', RUN_B), false)
  await rm(dir, { recursive: true, force: true })
})

test('a write leaves no partial file behind for a reader to trip over', async () => {
  const dir = await tempDir()
  await writeShutdownTurns(dir, recordOf(RUN_A, ['/s/a.jsonl']))
  // The temp sibling the atomic write uses must be gone once the rename lands.
  const text = await readFile(shutdownTurnsPath(dir), 'utf-8')
  assert.match(text, /"midTurn"/)
  await assert.rejects(readFile(`${shutdownTurnsPath(dir)}.tmp`, 'utf-8'))
  await rm(dir, { recursive: true, force: true })
})

test('consuming one chat leaves the others for their own ask', async () => {
  // The defect this pins: clearing the file on the first ask meant a quit that
  // interrupted three chats continued exactly one, and the other two were told
  // they had not been interrupted at all.
  const dir = await tempDir()
  const paths = ['/s/a.jsonl', '/s/b.jsonl', '/s/c.jsonl']
  await writeShutdownTurns(dir, recordOf(RUN_A, paths))

  for (const path of paths) {
    const before = await readShutdownTurns(dir)
    assert.equal(shouldContinueFromMarker(before, path, RUN_B), true, `${path} must be offered`)

    // Mirrors the IPC handler: consume exactly this chat.
    assert.ok(before)
    const { [path]: _dropped, ...rest } = before.midTurn
    await writeShutdownTurns(dir, { ...before, midTurn: rest })

    const after = await readShutdownTurns(dir)
    assert.equal(shouldContinueFromMarker(after, path, RUN_B), false, `${path} must not be offered twice`)
  }

  const final = await readShutdownTurns(dir)
  assert.deepEqual(final?.midTurn, {}, 'every claim is spent once all three chats asked')
  await rm(dir, { recursive: true, force: true })
})


test('a version 1 record is adopted, so an in-place update still continues', async () => {
  // The failure this pins: an update kills the app mid-turn, and the next start
  // is exactly the one that must continue. Refusing the old format made the
  // feature fail on the commonest interruption there is.
  const dir = await tempDir()
  await writeFile(
    shutdownTurnsPath(dir),
    JSON.stringify({
      version: 1,
      recordedAt: '2026-10-29T00:00:00.000Z',
      midTurn: { '/s/a.jsonl': '2026-10-29T00:00:00.000Z', '/s/b.jsonl': '2026-10-29T00:01:00.000Z' },
    }),
    'utf-8',
  )

  const record = await readShutdownTurns(dir)
  assert.ok(record, 'a v1 record must be readable')
  assert.equal(record.runId, LEGACY_RUN_ID)
  assert.equal(shouldContinueFromMarker(record, '/s/a.jsonl', RUN_B), true)
  assert.equal(shouldContinueFromMarker(record, '/s/b.jsonl', RUN_B), true)
  // No live run can hold the legacy name, so it can never match itself.
  assert.equal(shouldContinueFromMarker(record, '/s/a.jsonl', LEGACY_RUN_ID), false)
  await rm(dir, { recursive: true, force: true })
})
