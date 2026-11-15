import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createKeepAwakeCoordinator } from './keep-awake-coordinator'
import type { KeepAwake } from './keep-awake'
import type { SystemInhibitor } from './keep-awake-system-inhibitor'

interface Harness {
  desktopCalls: boolean[]
  probeCount: () => number
  acquireCount: () => number
  releaseCount: () => number
  coordinator: ReturnType<typeof createKeepAwakeCoordinator>
}

function createHarness(options: {
  platform: NodeJS.Platform
  hasDesktopSleepService?: boolean
  canAcquire?: boolean
}): Harness {
  const desktopCalls: boolean[] = []
  let probes = 0
  let acquires = 0
  let releases = 0
  let held = false

  const desktopBlocker: KeepAwake = {
    apply(enabled) {
      desktopCalls.push(enabled)
      return enabled
    },
    isActive: () => desktopCalls.at(-1) === true,
  }
  const systemInhibitor: SystemInhibitor = {
    async acquire() {
      acquires++
      held = options.canAcquire ?? true
      return held
    },
    release() {
      releases++
      held = false
    },
    isHeld: () => held,
  }
  const coordinator = createKeepAwakeCoordinator({
    platform: options.platform,
    desktopBlocker,
    systemInhibitor,
    hasDesktopSleepService: async () => {
      probes++
      return options.hasDesktopSleepService ?? false
    },
  })
  return {
    desktopCalls,
    probeCount: () => probes,
    acquireCount: () => acquires,
    releaseCount: () => releases,
    coordinator,
  }
}

test('the status is off before anything is applied', () => {
  const h = createHarness({ platform: 'linux' })
  assert.equal(h.coordinator.getStatus(), 'off')
})

for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform} uses only the desktop blocker`, async () => {
    const h = createHarness({ platform })

    assert.equal(await h.coordinator.apply(true), 'active')
    assert.deepEqual(h.desktopCalls, [true])
    assert.equal(h.probeCount(), 0)
    assert.equal(h.acquireCount(), 0)
  })
}

test('linux with a desktop sleep service uses only the desktop blocker', async () => {
  const h = createHarness({ platform: 'linux', hasDesktopSleepService: true })

  assert.equal(await h.coordinator.apply(true), 'active')
  assert.deepEqual(h.desktopCalls, [true])
  assert.equal(h.acquireCount(), 0)
})

test('linux without a desktop sleep service takes the system inhibitor', async () => {
  const h = createHarness({ platform: 'linux', hasDesktopSleepService: false, canAcquire: true })

  assert.equal(await h.coordinator.apply(true), 'active')
  assert.equal(h.acquireCount(), 1)
})

test('linux with no service and no system inhibitor is unsupported', async () => {
  const h = createHarness({ platform: 'linux', hasDesktopSleepService: false, canAcquire: false })

  assert.equal(await h.coordinator.apply(true), 'unsupported')
  assert.equal(h.coordinator.getStatus(), 'unsupported')
})

test('apply(false) releases both layers and reports off', async () => {
  const h = createHarness({ platform: 'linux', hasDesktopSleepService: false })
  await h.coordinator.apply(true)

  assert.equal(await h.coordinator.apply(false), 'off')
  assert.deepEqual(h.desktopCalls, [true, false])
  assert.equal(h.releaseCount(), 1)
})

test('calls that overlap run in order, so the last one wins', async () => {
  const h = createHarness({ platform: 'linux', hasDesktopSleepService: false })

  const on = h.coordinator.apply(true)
  const off = h.coordinator.apply(false)

  assert.equal(await on, 'active')
  assert.equal(await off, 'off')
  assert.equal(h.coordinator.getStatus(), 'off')
  assert.deepEqual(h.desktopCalls, [true, false])
})

test('a lost system inhibitor turns an active status into unsupported', async () => {
  const h = createHarness({ platform: 'linux', hasDesktopSleepService: false })
  await h.coordinator.apply(true)

  h.coordinator.handleSystemInhibitorLost()

  assert.equal(h.coordinator.getStatus(), 'unsupported')
})

test('a lost system inhibitor does not change an off status', async () => {
  const h = createHarness({ platform: 'linux', hasDesktopSleepService: false })
  await h.coordinator.apply(true)
  await h.coordinator.apply(false)

  h.coordinator.handleSystemInhibitorLost()

  assert.equal(h.coordinator.getStatus(), 'off')
})
