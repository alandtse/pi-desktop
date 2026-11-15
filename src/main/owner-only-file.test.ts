import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { tmpdir } from 'os'
import { writeOwnerOnlyFile } from './owner-only-file'

const OWNER_ONLY_MODE = 0o600
const PERMISSION_BITS = 0o777

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pi-owner-only-'))
}

/** Temp files this module may have left next to `path`. */
async function leftovers(path: string): Promise<string[]> {
  const names = await readdir(dirname(path))
  return names.filter((name) => name !== basename(path))
}

test('the content is written to the file', async () => {
  const path = join(await tempDir(), 'secret')
  await writeOwnerOnlyFile(path, 'first\n')
  assert.equal(await readFile(path, 'utf8'), 'first\n')
})

test('the file is readable by its owner only', { skip: process.platform === 'win32' }, async () => {
  const path = join(await tempDir(), 'secret')
  await writeOwnerOnlyFile(path, 'first\n')
  assert.equal((await stat(path)).mode & PERMISSION_BITS, OWNER_ONLY_MODE)
})

test('a second write replaces the content and keeps the mode', { skip: process.platform === 'win32' }, async () => {
  const path = join(await tempDir(), 'secret')
  await writeOwnerOnlyFile(path, 'first\n')
  await writeOwnerOnlyFile(path, 'second\n')

  assert.equal(await readFile(path, 'utf8'), 'second\n')
  assert.equal((await stat(path)).mode & PERMISSION_BITS, OWNER_ONLY_MODE)
})

test('missing parent folders are created', async () => {
  const path = join(await tempDir(), 'a', 'b', 'secret')
  await writeOwnerOnlyFile(path, 'x')
  assert.equal(await readFile(path, 'utf8'), 'x')
})

test('no temp file is left after a write', async () => {
  const path = join(await tempDir(), 'secret')
  await writeOwnerOnlyFile(path, 'x')
  assert.deepEqual(await leftovers(path), [])
})

test('a failed write removes its temp file and throws', async () => {
  const path = join(await tempDir(), 'secret')
  // A folder at the target makes the rename fail.
  await mkdir(path)

  await assert.rejects(writeOwnerOnlyFile(path, 'x'))
  assert.deepEqual(await leftovers(path), [])
})
