import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'

const OWNER_ONLY_MODE = 0o600

/**
 * Write a file that only its owner can read. A fresh temp file is created
 * owner-only and renamed over the target, so the content is never readable by
 * others, even for a moment, and a crash never leaves half a file.
 */
export async function writeOwnerOnlyFile(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(tempPath, content, { mode: OWNER_ONLY_MODE })
    await rename(tempPath, path)
  } catch (err) {
    // Never leave a stray copy of the content behind.
    await rm(tempPath, { force: true })
    throw err
  }
}
