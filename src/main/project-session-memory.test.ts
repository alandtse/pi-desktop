/**
 * A project tab must come back to the chat the user left it on.
 *
 * The rule used to be "the newest session file", which answers a different
 * question and lands the tab on whichever chat happened to be written last —
 * often one the user never opened.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/** Point the store at a temp userData dir before importing it. */
async function withStore<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'psm-'))
  const previous = process.env.PI_DESKTOP_USER_DATA_DIR
  process.env.PI_DESKTOP_USER_DATA_DIR = dir
  try {
    return await run(dir)
  } finally {
    if (previous === undefined) delete process.env.PI_DESKTOP_USER_DATA_DIR
    else process.env.PI_DESKTOP_USER_DATA_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
}

const PROJECT = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'
const OLDER = process.platform === 'win32' ? 'C:\\work\\app\\a.jsonl' : '/work/app/a.jsonl'
const NEWER = process.platform === 'win32' ? 'C:\\work\\app\\b.jsonl' : '/work/app/b.jsonl'
const OTHER = process.platform === 'win32' ? 'C:\\work\\other' : '/work/other'

test('a project remembers the session it was last showing', async () => {
  await withStore(async () => {
    const { ProjectSessionMemory } = await import('./project-session-memory')
    const memory = new ProjectSessionMemory()
    assert.equal(await memory.get(PROJECT), null, 'nothing recorded yet')
    await memory.remember(PROJECT, OLDER)
    assert.equal(await memory.get(PROJECT), OLDER)
    // A later choice replaces it; the newest file on disk is irrelevant to this.
    await memory.remember(PROJECT, NEWER)
    assert.equal(await memory.get(PROJECT), NEWER)
  })
})

test('the record follows the project, not the process', async () => {
  await withStore(async () => {
    const first = (await import('./project-session-memory')).ProjectSessionMemory
    await new first().remember(PROJECT, OLDER)
    // A second instance stands in for the next launch: the file is the only
    // thing carrying the choice across it.
    const reopened = new first()
    assert.equal(await reopened.get(PROJECT), OLDER, 'a restart must not forget the chat')
    assert.equal(await reopened.get(OTHER), null, 'each project has its own memory')
  })
})

test('paths differing only by a trailing separator are the same project', async () => {
  await withStore(async () => {
    const { ProjectSessionMemory } = await import('./project-session-memory')
    const memory = new ProjectSessionMemory()
    await memory.remember(PROJECT, OLDER)
    assert.equal(await memory.get(`${PROJECT}${process.platform === 'win32' ? '\\' : '/'}`), OLDER)
  })
})

test('an empty path is refused rather than stored as a choice', async () => {
  await withStore(async () => {
    const { ProjectSessionMemory } = await import('./project-session-memory')
    const memory = new ProjectSessionMemory()
    await memory.remember(PROJECT, '')
    await memory.remember('', OLDER)
    assert.equal(await memory.get(PROJECT), null)
    assert.deepEqual(await memory.getAll(), {})
  })
})

test('forgetting a project drops only its own record', async () => {
  await withStore(async () => {
    const { ProjectSessionMemory } = await import('./project-session-memory')
    const memory = new ProjectSessionMemory()
    await memory.remember(PROJECT, OLDER)
    await memory.remember(OTHER, NEWER)
    await memory.forget(PROJECT)
    assert.equal(await memory.get(PROJECT), null)
    assert.equal(await memory.get(OTHER), NEWER, 'another project keeps its chat')
  })
})

test('a corrupt file is treated as no memory, not a crash', async () => {
  await withStore(async (dir) => {
    const { ProjectSessionMemory } = await import('./project-session-memory')
    // Written where the manager looks, so the load path actually parses it.
    await writeFile(join(dir, 'project-sessions.json'), 'not json', 'utf-8')
    const memory = new ProjectSessionMemory()
    assert.equal(await memory.get(PROJECT), null)
  })
})
