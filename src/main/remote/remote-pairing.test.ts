import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  AUTH_FAILURE_WINDOW_MS,
  AUTH_LOCKOUT_MS,
  MAX_AUTH_FAILURES,
  PAIRING_CODE_TTL_MS,
  createDeviceFileStore,
  createRemotePairing,
  type PairedDevice,
} from './remote-pairing'

const PHONE = '100.101.102.103'
const OTHER_PHONE = '100.101.102.104'
const OWNER_ONLY_MODE = 0o600
const PERMISSION_BITS = 0o777

interface Harness {
  pairing: ReturnType<typeof createRemotePairing>
  stored: () => PairedDevice[]
  confirmRequests: Array<{ label: string; remoteAddress: string }>
  removed: string[]
  advance(ms: number): void
  setApproval(next: boolean): void
}

function createHarness(initial: PairedDevice[] = []): Harness {
  let now = 1_000_000
  let approve = true
  let stored = initial
  const confirmRequests: Harness['confirmRequests'] = []
  const removed: string[] = []
  const pairing = createRemotePairing({
    now: () => now,
    randomBytes,
    confirmPairing: async (request) => {
      confirmRequests.push(request)
      return approve
    },
    loadDevices: async () => stored,
    saveDevices: async (devices) => {
      stored = devices
    },
    onDeviceRemoved: (deviceId) => removed.push(deviceId),
  })
  return {
    pairing,
    stored: () => stored,
    confirmRequests,
    removed,
    advance: (ms) => {
      now += ms
    },
    setApproval: (next) => {
      approve = next
    },
  }
}

async function pair(h: Harness, label = 'My phone', address = PHONE): Promise<{ token: string; deviceId: string }> {
  const { code } = h.pairing.createPairingCode()
  const result = await h.pairing.redeemPairingCode(code, label, address)
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('unreachable')
  return { token: result.token, deviceId: result.device.deviceId }
}

test('a redeemed code returns a token that authenticates', async () => {
  const h = createHarness()
  const { token, deviceId } = await pair(h)

  const device = await h.pairing.authenticate(token, PHONE)
  assert.equal(device?.deviceId, deviceId)
  assert.equal(device?.label, 'My phone')
  assert.deepEqual(h.confirmRequests, [{ label: 'My phone', remoteAddress: PHONE }])
})

test('codes and tokens are URL-safe and long enough', async () => {
  const h = createHarness()
  const { code } = h.pairing.createPairingCode()
  const result = await h.pairing.redeemPairingCode(code, 'x', PHONE)

  assert.match(code, /^[A-Za-z0-9_-]{22}$/)
  assert.equal(result.ok, true)
  if (result.ok) assert.match(result.token, /^[A-Za-z0-9_-]{43}$/)
})

test('the store holds a hash and never the token', async () => {
  const h = createHarness()
  const { token } = await pair(h)

  const record = h.stored()[0]
  assert.match(record.tokenHash, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(h.stored()).includes(token), false)
})

test('the public device has no token hash', async () => {
  const h = createHarness()
  await pair(h)

  const listed = await h.pairing.listDevices()
  assert.equal(listed.length, 1)
  assert.equal('tokenHash' in listed[0], false)
})

test('a wrong code is refused and asks nobody', async () => {
  const h = createHarness()
  h.pairing.createPairingCode()

  assert.deepEqual(await h.pairing.redeemPairingCode('wrong-code', 'x', PHONE), { ok: false, reason: 'invalid_code' })
  assert.equal(h.confirmRequests.length, 0)
})

test('a redeem with no code created is refused', async () => {
  const h = createHarness()
  assert.deepEqual(await h.pairing.redeemPairingCode('anything', 'x', PHONE), { ok: false, reason: 'invalid_code' })
})

test('a code expires', async () => {
  const h = createHarness()
  const { code, expiresAt } = h.pairing.createPairingCode()
  h.advance(PAIRING_CODE_TTL_MS + 1)

  assert.equal(expiresAt, 1_000_000 + PAIRING_CODE_TTL_MS)
  assert.deepEqual(await h.pairing.redeemPairingCode(code, 'x', PHONE), { ok: false, reason: 'invalid_code' })
})

test('a code works once', async () => {
  const h = createHarness()
  const { code } = h.pairing.createPairingCode()
  await h.pairing.redeemPairingCode(code, 'first', PHONE)

  assert.deepEqual(await h.pairing.redeemPairingCode(code, 'second', OTHER_PHONE), { ok: false, reason: 'invalid_code' })
  assert.equal(h.stored().length, 1)
})

test('a new code replaces the old one', async () => {
  const h = createHarness()
  const old = h.pairing.createPairingCode()
  const fresh = h.pairing.createPairingCode()

  assert.deepEqual(await h.pairing.redeemPairingCode(old.code, 'x', PHONE), { ok: false, reason: 'invalid_code' })
  assert.equal((await h.pairing.redeemPairingCode(fresh.code, 'x', PHONE)).ok, true)
})

test('a denial stores nothing and uses up the code', async () => {
  const h = createHarness()
  h.setApproval(false)
  const { code } = h.pairing.createPairingCode()

  assert.deepEqual(await h.pairing.redeemPairingCode(code, 'x', PHONE), { ok: false, reason: 'denied' })
  assert.equal(h.stored().length, 0)

  h.setApproval(true)
  assert.deepEqual(await h.pairing.redeemPairingCode(code, 'x', PHONE), { ok: false, reason: 'invalid_code' })
})

test('an unknown token does not authenticate', async () => {
  const h = createHarness()
  await pair(h)
  assert.equal(await h.pairing.authenticate('not-a-token', PHONE), null)
})

test('authenticate records when the device was last seen', async () => {
  const h = createHarness()
  const { token } = await pair(h)
  h.advance(5_000)
  await h.pairing.authenticate(token, PHONE)

  assert.equal(h.stored()[0].lastSeenAt, 1_005_000)
  assert.equal(h.stored()[0].pairedAt, 1_000_000)
})

test('a removed device stops authenticating and the removal is announced', async () => {
  const h = createHarness()
  const { token, deviceId } = await pair(h)

  assert.equal(await h.pairing.removeDevice(deviceId), true)
  assert.equal(await h.pairing.authenticate(token, PHONE), null)
  assert.deepEqual(h.removed, [deviceId])
  assert.equal(h.stored().length, 0)
})

test('removing an unknown device returns false and announces nothing', async () => {
  const h = createHarness()
  assert.equal(await h.pairing.removeDevice('nope'), false)
  assert.deepEqual(h.removed, [])
})

test('repeated failures lock an address out, also for a correct token', async () => {
  const h = createHarness()
  const { token } = await pair(h)
  for (let i = 0; i < MAX_AUTH_FAILURES; i++) await h.pairing.authenticate('bad', OTHER_PHONE)

  assert.equal(h.pairing.isLockedOut(OTHER_PHONE), true)
  assert.equal(await h.pairing.authenticate(token, OTHER_PHONE), null)
  assert.equal(h.pairing.isLockedOut(PHONE), false)
  assert.notEqual(await h.pairing.authenticate(token, PHONE), null)
})

test('a locked-out address cannot redeem a valid code, and the code survives', async () => {
  const h = createHarness()
  const { code } = h.pairing.createPairingCode()
  for (let i = 0; i < MAX_AUTH_FAILURES; i++) await h.pairing.redeemPairingCode('bad', 'x', OTHER_PHONE)

  assert.deepEqual(await h.pairing.redeemPairingCode(code, 'x', OTHER_PHONE), { ok: false, reason: 'locked_out' })
  assert.equal((await h.pairing.redeemPairingCode(code, 'x', PHONE)).ok, true)
})

test('the lockout ends after its time', async () => {
  const h = createHarness()
  const { token } = await pair(h)
  for (let i = 0; i < MAX_AUTH_FAILURES; i++) await h.pairing.authenticate('bad', PHONE)
  h.advance(AUTH_LOCKOUT_MS + 1)

  assert.equal(h.pairing.isLockedOut(PHONE), false)
  assert.notEqual(await h.pairing.authenticate(token, PHONE), null)
})

test('failures spread wider than the window do not lock out', async () => {
  const h = createHarness()
  for (let i = 0; i < MAX_AUTH_FAILURES * 2; i++) {
    await h.pairing.authenticate('bad', PHONE)
    h.advance(AUTH_FAILURE_WINDOW_MS)
  }
  assert.equal(h.pairing.isLockedOut(PHONE), false)
})

test('a success clears the failure count', async () => {
  const h = createHarness()
  const { token } = await pair(h)
  for (let i = 0; i < MAX_AUTH_FAILURES - 1; i++) await h.pairing.authenticate('bad', PHONE)
  await h.pairing.authenticate(token, PHONE)
  for (let i = 0; i < MAX_AUTH_FAILURES - 1; i++) await h.pairing.authenticate('bad', PHONE)

  assert.equal(h.pairing.isLockedOut(PHONE), false)
})

test('the label is trimmed, cut, and never empty', async () => {
  const h = createHarness()
  await pair(h, `  ${'x'.repeat(200)}  `)
  await pair(h, '   ')

  assert.equal(h.stored()[0].label, 'x'.repeat(80))
  assert.equal(h.stored()[1].label, 'Unknown device')
})

test('the device file round-trips and is owner-only', { skip: process.platform === 'win32' }, async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'pi-remote-devices-')), 'remote-devices.json')
  const store = createDeviceFileStore(path)
  const device: PairedDevice = { deviceId: 'd1', label: 'Phone', tokenHash: 'a'.repeat(64), pairedAt: 1, lastSeenAt: 2 }

  assert.deepEqual(await store.loadDevices(), [])
  await store.saveDevices([device])

  assert.deepEqual(await createDeviceFileStore(path).loadDevices(), [device])
  assert.equal((await stat(path)).mode & PERMISSION_BITS, OWNER_ONLY_MODE)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).devices.length, 1)
})

test('a malformed device file loads as no devices, and bad records are dropped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-remote-devices-'))
  const broken = join(dir, 'broken.json')
  await writeFile(broken, '{not json')
  assert.deepEqual(await createDeviceFileStore(broken).loadDevices(), [])

  const mixed = join(dir, 'mixed.json')
  const good: PairedDevice = { deviceId: 'd1', label: 'Phone', tokenHash: 'b'.repeat(64), pairedAt: 1, lastSeenAt: 2 }
  await writeFile(mixed, JSON.stringify({ devices: [good, { deviceId: 'd2' }, 'text', null] }))
  assert.deepEqual(await createDeviceFileStore(mixed).loadDevices(), [good])
})
