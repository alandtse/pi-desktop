/**
 * Tells a room running on THIS machine from one running on another.
 *
 * The relay speaks for every paired Pi, so a roster frame says "peer X has room
 * R" without ever saying which physical machine that is. Two machines that both
 * pair with each other therefore advertise rooms to one another, and the local
 * one would appear twice: once from disk and once as a remote row.
 *
 * The distinguishing fact is the cwd lock. `remote-pi` pins
 * `<REMOTE_PI_HOME>/locks/<roomId>.sock` for as long as a Pi is running in that
 * folder. The socket is kernel-held, so a crashed holder leaves a file that
 * refuses a connection rather than a socket that lies, and the OS releases it
 * the instant the process dies. A room whose socket answers on this machine is
 * running here — that is the whole test.
 *
 * A named pipe is used on Windows (`lock-<id>`), where the same connect probe
 * applies; only the address differs.
 */
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** How long a probe may take before the room is assumed to live elsewhere. */
const PROBE_TIMEOUT_MS = 400

/**
 * Directory holding the per-room lock sockets.
 *
 * Resolved on every call rather than at module load: `remote-pi` honors
 * `REMOTE_PI_HOME` for tests, and a value read at import time would lock this
 * module to whatever the environment said when the process started.
 */
export function locksDir(): string {
  const root = process.env['REMOTE_PI_HOME'] || homedir()
  return join(root, '.pi', 'remote', 'locks')
}

/** The lock address for a room on this machine (POSIX socket or Windows pipe). */
export function lockAddress(roomId: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\lock-${roomId}`
  return join(locksDir(), `${roomId}.sock`)
}

/**
 * Whether a live Pi holds `roomId` on this machine.
 *
 * A connection is the only honest probe: the socket has no listener logic, and
 * the holder never reads what arrives, so connecting and immediately destroying
 * the socket is invisible to it. Refused/timed-out means no holder here — either
 * the file is a leftover from a crashed process or the room is another machine's.
 */
export function isLocalRoom(roomId: string): Promise<boolean> {
  if (!roomId) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const done = (result: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const socket = connect(lockAddress(roomId))
    // A slow probe must not stall the session list. An unanswered socket is
    // treated as remote, which is the conservative answer: the row still
    // appears, it is just grouped with the other machines.
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS)
    socket.on('connect', () => done(true))
    socket.on('error', () => done(false))
  })
}

/**
 * Locality for several rooms at once, keyed by room id.
 *
 * Probes run concurrently because they are independent and each one is bounded
 * by `PROBE_TIMEOUT_MS`; serializing them would multiply that bound by the
 * roster size.
 */
export async function localRooms(roomIds: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(roomIds.filter(Boolean))]
  const verdicts = await Promise.all(unique.map(async (id) => [id, await isLocalRoom(id)] as const))
  return new Set(verdicts.filter(([, local]) => local).map(([id]) => id))
}

/**
 * Cached locality, keyed by room id.
 *
 * A connect probe is cheap but not free, and the status is re-emitted on every
 * roster change and renderer request. Room ids name a running process, so a
 * verdict stays true until that process exits — the short TTL is only there to
 * bound how long a room that just ended keeps looking local.
 */
const CACHE_TTL_MS = 2_000
const cache = new Map<string, { local: boolean; at: number }>()

/**
 * Drops every cached verdict.
 *
 * The cache is keyed by room id, and a room id is stable for the life of the
 * folder's lock — so a test that binds a socket for an id it has already probed
 * would otherwise see the old answer. Production never needs this: rooms appear
 * and disappear, and the TTL bounds any staleness.
 */
export function resetLocalRoomsCache(): void {
  cache.clear()
}

export async function localRoomsCached(roomIds: readonly string[]): Promise<Set<string>> {
  const now = Date.now()
  const unique = [...new Set(roomIds.filter(Boolean))]
  const stale = unique.filter((id) => {
    const hit = cache.get(id)
    return !hit || now - hit.at > CACHE_TTL_MS
  })
  if (stale.length > 0) {
    const fresh = await localRooms(stale)
    for (const id of stale) cache.set(id, { local: fresh.has(id), at: now })
  }
  return new Set(unique.filter((id) => cache.get(id)?.local))
}
