/**
 * Remembers which chats had a turn open when a run of the app stopped, so the
 * next start can continue exactly those and nothing else.
 *
 * Why a claim rather than a flag: the earlier design kept one global record whose
 * `recordedAt` was rewritten on every turn change, so the timestamp meant "last
 * activity" and could never mean "when this run died". With no way to tell one
 * run's record from another's, a claim could be offered on a start it did not
 * belong to — the old session that restarts for no reason.
 *
 * Every claim now names the run that wrote it (`runId`, `pid`), and a claim is
 * only offered to a DIFFERENT run. Consumption deletes exactly one entry, so five
 * chats interrupted by one quit each get their own answer instead of the first
 * one restored taking the whole record.
 */
import { renameSync, writeFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'

/** One chat that had a turn open, and the run that saw it. */
export interface TurnClaim {
  /** Run that recorded the claim. A claim is never offered back to its own run. */
  runId: string
  /** Process that recorded it, for reading the file by hand. */
  pid: number
  /** ISO timestamp of the turn's start. */
  startedAt: string
  /** ISO timestamp of the last activity seen inside the turn. */
  lastSeenAt: string
}

/** What a stopped run leaves for the next one. */
export interface ShutdownTurns {
  /** Run that wrote this file most recently. */
  runId: string
  /** ISO timestamp of the last write. */
  recordedAt: string
  /**
   * True only when the app shut itself down.
   *
   * Absent or false means the run ended some other way — a crash, a forced kill,
   * a power loss. Not a gate on its own: a turn whose window died with the
   * machine was genuinely cut short and must still be continued. It exists so
   * the file can answer "why did this not continue?" without reading the log.
   */
  cleanExit: boolean
  /** Chats with a turn open, keyed by absolute session file path. */
  midTurn: Record<string, TurnClaim>
}

const MARKER_VERSION = 2
/** Version that stored bare timestamps, still read so an upgrade restart continues. */
const LEGACY_VERSION = 1
/** Name given to v1 claims. No live run can match it, so they read as a dead run's. */
export const LEGACY_RUN_ID = 'legacy'

interface MarkerFile {
  version: number
  runId: string
  recordedAt: string
  cleanExit: boolean
  midTurn: Record<string, TurnClaim>
}

/** Path of the marker, beside the app's other GUI state. */
export function shutdownTurnsPath(guiDataDir: string): string {
  return `${guiDataDir}/shutdown-turns.json`
}

/** A fresh record for a run that has just started. */
export function emptyRecord(runId: string, now = new Date().toISOString()): ShutdownTurns {
  return { runId, recordedAt: now, cleanExit: false, midTurn: {} }
}

function isClaim(value: unknown): value is TurnClaim {
  if (!value || typeof value !== 'object') return false
  const claim = value as Partial<TurnClaim>
  return typeof claim.runId === 'string' && claim.runId.length > 0
}

/**
 * Reads the marker a previous run left.
 *
 * Any problem — missing, unreadable, wrong shape, a version this build does not
 * speak — is reported as no record at all, because continuing a turn nobody asked
 * for is worse than not continuing one that was wanted.
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
  const candidate = parsed as Partial<MarkerFile> & { version?: number }
  const midTurn = candidate.midTurn
  if (!midTurn || typeof midTurn !== 'object') return null

  // Version 1 stored bare ISO timestamps and no run identity. It is still
  // readable, and refusing it defeated the commonest interruption there is: an
  // in-place update, where the deploy kills the app mid-turn and the very next
  // start is the one that should continue. Any record found at startup was
  // written by a previous process — the single-instance lock guarantees only one
  // app runs — so a v1 claim is unambiguously from a dead run and is adopted
  // under a name no live run can hold.
  if (candidate.version === LEGACY_VERSION) {
    const adopted: Record<string, TurnClaim> = {}
    for (const [path, startedAt] of Object.entries(midTurn as Record<string, unknown>)) {
      if (typeof startedAt !== 'string') continue
      adopted[path] = {
        runId: LEGACY_RUN_ID,
        pid: 0,
        startedAt,
        lastSeenAt: startedAt,
      }
    }
    return {
      runId: LEGACY_RUN_ID,
      recordedAt: typeof candidate.recordedAt === 'string' ? candidate.recordedAt : '',
      cleanExit: candidate.cleanExit === true,
      midTurn: adopted,
    }
  }

  if (candidate.version !== MARKER_VERSION) return null
  if (typeof candidate.runId !== 'string' || typeof candidate.recordedAt !== 'string') return null
  const clean: Record<string, TurnClaim> = {}
  for (const [path, claim] of Object.entries(midTurn as Record<string, unknown>)) {
    if (isClaim(claim)) clean[path] = claim
  }
  return {
    runId: candidate.runId,
    recordedAt: candidate.recordedAt,
    cleanExit: candidate.cleanExit === true,
    midTurn: clean,
  }
}

function payload(record: ShutdownTurns): string {
  const body: MarkerFile = {
    version: MARKER_VERSION,
    runId: record.runId,
    recordedAt: record.recordedAt,
    cleanExit: record.cleanExit,
    midTurn: record.midTurn,
  }
  return `${JSON.stringify(body, null, 2)}\n`
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
  await writeFile(temp, payload(record), 'utf-8')
  await rename(temp, target)
}

/**
 * Writes the marker synchronously, for the quit path and for every live update.
 *
 * Synchronous because the quit path cannot wait: the same handler stops the Pi
 * managers, which ends their turns, so an async write would race the state it is
 * recording. The rename is what makes a partial write unreadable rather than
 * misleading.
 */
export function writeShutdownTurnsSync(guiDataDir: string, record: ShutdownTurns): void {
  const target = shutdownTurnsPath(guiDataDir)
  const temp = `${target}.tmp`
  writeFileSync(temp, payload(record), 'utf-8')
  renameSync(temp, target)
}

/**
 * Whether a claim should be offered to the caller's run.
 *
 * The claim must have been recorded by a DIFFERENT run: one written by this run
 * describes a turn that is still live, and continuing it would send a prompt into
 * a conversation that is already working. A clean exit by the recording run still
 * leaves the claim valid — the turn was open when the app closed, which is
 * exactly what the feature recovers.
 */
export function shouldContinueFromMarker(
  record: ShutdownTurns | null,
  sessionPath: string,
  currentRunId: string,
): boolean {
  if (!record) return false
  if (record.runId === currentRunId) return false
  const claim = record.midTurn[sessionPath]
  if (!claim) return false
  return claim.runId !== currentRunId
}

/** The claim for one chat, if it belongs to an earlier run. */
export function claimFor(
  record: ShutdownTurns | null,
  sessionPath: string,
  currentRunId: string,
): TurnClaim | null {
  if (!record || !shouldContinueFromMarker(record, sessionPath, currentRunId)) return null
  return record.midTurn[sessionPath] ?? null
}
