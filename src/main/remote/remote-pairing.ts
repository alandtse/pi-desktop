import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'fs/promises'
import { MAX_DEVICE_LABEL_CHARS } from '../../shared/remote-protocol'
import { writeOwnerOnlyFile } from '../owner-only-file'

export const PAIRING_CODE_BYTES = 16
export const DEVICE_TOKEN_BYTES = 32
export const PAIRING_CODE_TTL_MS = 5 * 60_000
export const MAX_AUTH_FAILURES = 5
export const AUTH_FAILURE_WINDOW_MS = 60_000
export const AUTH_LOCKOUT_MS = 5 * 60_000

const DEVICE_ID_BYTES = 9
const SECRET_ENCODING = 'base64url'
const HASH_ALGORITHM = 'sha256'
const UNKNOWN_DEVICE_LABEL = 'Unknown device'

export interface PairedDevice {
  deviceId: string
  label: string
  /** SHA-256 of the device token, hex. The token itself is never stored. */
  tokenHash: string
  pairedAt: number
  lastSeenAt: number
}

export type PublicDevice = Omit<PairedDevice, 'tokenHash'>

export type PairingResult =
  | { ok: true; token: string; device: PublicDevice }
  | { ok: false; reason: 'invalid_code' | 'denied' | 'locked_out' }

export interface RemotePairingDeps {
  now(): number
  randomBytes(size: number): Buffer
  /** Ask the person at the desktop. Only an explicit yes pairs the device. */
  confirmPairing(request: { label: string; remoteAddress: string }): Promise<boolean>
  loadDevices(): Promise<PairedDevice[]>
  saveDevices(devices: PairedDevice[]): Promise<void>
  onDeviceRemoved(deviceId: string): void
}

export interface RemotePairing {
  createPairingCode(): { code: string; expiresAt: number }
  redeemPairingCode(code: string, label: string, remoteAddress: string): Promise<PairingResult>
  authenticate(token: string, remoteAddress: string): Promise<PublicDevice | null>
  listDevices(): Promise<PublicDevice[]>
  removeDevice(deviceId: string): Promise<boolean>
  isLockedOut(remoteAddress: string): boolean
}

interface FailureRecord {
  count: number
  windowStartedAt: number
  lockedUntil: number
}

function digest(secret: string): Buffer {
  return createHash(HASH_ALGORITHM).update(secret).digest()
}

/** Compares digests, so both sides always have the same length. */
function digestsMatch(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

function toPublic(device: PairedDevice): PublicDevice {
  return { deviceId: device.deviceId, label: device.label, pairedAt: device.pairedAt, lastSeenAt: device.lastSeenAt }
}

function cleanLabel(label: string): string {
  return label.trim().slice(0, MAX_DEVICE_LABEL_CHARS) || UNKNOWN_DEVICE_LABEL
}

/**
 * Pairing codes and paired devices. Being on the same private network is not
 * trust: a device gets nothing until a person at the desktop approved it, and
 * each device can be removed alone.
 *
 * Electron-free: the clock, the random source, the approval prompt and the
 * storage are injected, so this runs under node:test.
 */
export function createRemotePairing(deps: RemotePairingDeps): RemotePairing {
  let activeCode: { digest: Buffer; expiresAt: number } | null = null
  let devices: PairedDevice[] | null = null
  const failures = new Map<string, FailureRecord>()

  async function loaded(): Promise<PairedDevice[]> {
    devices ??= await deps.loadDevices()
    return devices
  }

  async function store(next: PairedDevice[]): Promise<void> {
    devices = next
    await deps.saveDevices(next)
  }

  function isLockedOut(remoteAddress: string): boolean {
    return (failures.get(remoteAddress)?.lockedUntil ?? 0) > deps.now()
  }

  function recordFailure(remoteAddress: string): void {
    const now = deps.now()
    // Forget addresses whose window and lockout are both over, so the map
    // cannot grow without limit.
    for (const [address, record] of failures) {
      if (record.lockedUntil <= now && now - record.windowStartedAt >= AUTH_FAILURE_WINDOW_MS) failures.delete(address)
    }
    const record = failures.get(remoteAddress) ?? { count: 0, windowStartedAt: now, lockedUntil: 0 }
    record.count++
    if (record.count >= MAX_AUTH_FAILURES) record.lockedUntil = now + AUTH_LOCKOUT_MS
    failures.set(remoteAddress, record)
  }

  return {
    isLockedOut,

    createPairingCode() {
      const code = deps.randomBytes(PAIRING_CODE_BYTES).toString(SECRET_ENCODING)
      const expiresAt = deps.now() + PAIRING_CODE_TTL_MS
      activeCode = { digest: digest(code), expiresAt }
      return { code, expiresAt }
    },

    async redeemPairingCode(code, label, remoteAddress) {
      if (isLockedOut(remoteAddress)) return { ok: false, reason: 'locked_out' }

      const candidate = activeCode
      if (!candidate || candidate.expiresAt <= deps.now() || !digestsMatch(candidate.digest, digest(code))) {
        recordFailure(remoteAddress)
        return { ok: false, reason: 'invalid_code' }
      }
      // Used up before the prompt: a second request with the same code, sent
      // while the prompt is open, must not get its own prompt.
      activeCode = null
      failures.delete(remoteAddress)

      const cleanedLabel = cleanLabel(label)
      if (!(await deps.confirmPairing({ label: cleanedLabel, remoteAddress }))) return { ok: false, reason: 'denied' }

      const token = deps.randomBytes(DEVICE_TOKEN_BYTES).toString(SECRET_ENCODING)
      const now = deps.now()
      const device: PairedDevice = {
        deviceId: deps.randomBytes(DEVICE_ID_BYTES).toString(SECRET_ENCODING),
        label: cleanedLabel,
        tokenHash: digest(token).toString('hex'),
        pairedAt: now,
        lastSeenAt: now,
      }
      await store([...(await loaded()), device])
      return { ok: true, token, device: toPublic(device) }
    },

    async authenticate(token, remoteAddress) {
      if (isLockedOut(remoteAddress)) return null

      const tokenDigest = digest(token)
      const current = await loaded()
      const match = current.find((device) => digestsMatch(Buffer.from(device.tokenHash, 'hex'), tokenDigest))
      if (!match) {
        recordFailure(remoteAddress)
        return null
      }
      failures.delete(remoteAddress)
      const seen: PairedDevice = { ...match, lastSeenAt: deps.now() }
      await store(current.map((device) => (device === match ? seen : device)))
      return toPublic(seen)
    },

    async listDevices() {
      return (await loaded()).map(toPublic)
    },

    async removeDevice(deviceId) {
      const current = await loaded()
      if (!current.some((device) => device.deviceId === deviceId)) return false
      await store(current.filter((device) => device.deviceId !== deviceId))
      deps.onDeviceRemoved(deviceId)
      return true
    },
  }
}

function isPairedDevice(value: unknown): value is PairedDevice {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.deviceId === 'string' &&
    typeof record.label === 'string' &&
    typeof record.tokenHash === 'string' &&
    typeof record.pairedAt === 'number' &&
    typeof record.lastSeenAt === 'number'
  )
}

/** The paired-device list as an owner-only JSON file. */
export function createDeviceFileStore(path: string): Pick<RemotePairingDeps, 'loadDevices' | 'saveDevices'> {
  return {
    async loadDevices() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        const list = (parsed as { devices?: unknown } | null)?.devices
        return Array.isArray(list) ? list.filter(isPairedDevice) : []
      } catch {
        // A missing or unreadable file means no device is paired.
        return []
      }
    },
    async saveDevices(devices) {
      await writeOwnerOnlyFile(path, `${JSON.stringify({ devices }, null, 2)}\n`)
    },
  }
}
