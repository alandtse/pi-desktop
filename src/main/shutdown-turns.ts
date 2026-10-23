/**
 * Remembers which chats were mid-turn when the app last closed.
 *
 * Why this exists: deciding "was this turn interrupted?" by inferring from the
 * session file cannot distinguish a turn the app's own quit cut short from one
 * that was simply the last thing written before the user quit on purpose. Both
 * end on an unanswered tool call, so the file alone is ambiguous, and a session
 * that quietly did not continue is indistinguishable from one that never needed
 * to.
 *
 * Recording the answer at the moment of closing removes the inference: a chat is
 * continued on start only if it was genuinely working when the app went down.
 * The file check still runs, because the file is the authority on what can be
 * resumed — but it now answers "what can I resume?" instead of "did something go
 * wrong?", which is the question it can actually answer.
 */
import { renameSync, writeFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'

/** Recorded chats, keyed by absolute session file path. */
export interface ShutdownTurns {
  /** ISO timestamp of the quit that produced this record. */
  recordedAt: string
  /** Session files that were mid-turn, with the time the turn began. */
  midTurn: Record<string, string>
}

const MARKER_VERSION = 1

interface MarkerFile extends ShutdownTurns {
  version: number
}

/** Path of the marker, beside the app's other GUI state. */
export function shutdownTurnsPath(guiDataDir: string): string {
  return `${guiDataDir}/shutdown-turns.json`
}

/**
 * Reads the marker a previous run left.
 *
 * Any problem — missing, unreadable, wrong shape — is reported as no record at
 * all, because continuing a turn nobody asked for is worse than not continuing
 * one that was wanted.
 */
export async function readShutdownTurns(guiDataDir: string): Promise<ShutdownTurns | null> {
  let text: string
  try {
    text = await readFile(shutdownTurnsPath(guiDataDir), 'utf-8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const candidate = parsed as Partial<MarkerFile>
  if (candidate.version !== MARKER_VERSION) return null
  if (typeof candidate.recordedAt !== 'string') return null
  const midTurn = candidate.midTurn
  if (!midTurn || typeof midTurn !== 'object') return null
  const clean: Record<string, string> = {}
  for (const [path, startedAt] of Object.entries(midTurn)) {
    if (typeof startedAt === 'string') clean[path] = startedAt
  }
  return { recordedAt: candidate.recordedAt, midTurn: clean }
}

/**
 * Writes the marker atomically.
 *
 * Written to a sibling and renamed so a quit that dies mid-write cannot leave a
 * half-file that reads as "nothing was running" and silently drops the
 * continuation.
 */
export async function writeShutdownTurns(guiDataDir: string, record: ShutdownTurns): Promise<void> {
  const target = shutdownTurnsPath(guiDataDir)
  const temp = `${target}.tmp`
  const payload: MarkerFile = { version: MARKER_VERSION, ...record }
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  await rename(temp, target)
}

/**
 * Writes the marker synchronously, for the quit path.
 *
 * A quit cannot await: the same handler stops the Pi managers, which ends their
 * turns, so an async write would race the state it is recording. The rename is
 * what makes a partial write unreadable rather than misleading.
 */
export function writeShutdownTurnsSync(guiDataDir: string, record: ShutdownTurns): void {
  const target = shutdownTurnsPath(guiDataDir)
  const temp = `${target}.tmp`
  const payload: MarkerFile = { version: MARKER_VERSION, ...record }
  writeFileSync(temp, `${JSON.stringify(payload, null, 2)}
`, 'utf-8')
  renameSync(temp, target)
}

/** Clears the marker once its contents have been acted on. */
export async function clearShutdownTurns(guiDataDir: string): Promise<void> {
  try {
    await writeFile(shutdownTurnsPath(guiDataDir), `${JSON.stringify({ version: MARKER_VERSION, recordedAt: '', midTurn: {} })}\n`, 'utf-8')
  } catch {
    // A marker that cannot be cleared only causes a redundant check next start;
    // the file check still gates the send, so failing loudly here would cost more
    // than it warns about.
  }
}

/**
 * The chats to continue at startup.
 *
 * A session continues only when the marker names it as mid-turn AND that path is
 * the session the caller is opening — so a quit with three chats working does not
 * send prompts into whichever one happens to be restored.
 */
export function shouldContinueFromMarker(
  record: ShutdownTurns | null,
  sessionPath: string,
): boolean {
  if (!record) return false
  return Object.prototype.hasOwnProperty.call(record.midTurn, sessionPath)
}
