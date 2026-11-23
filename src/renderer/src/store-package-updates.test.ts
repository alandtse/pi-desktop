import { before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { InstalledPackage, PackageUpdate } from '../../shared/ipc-contracts'

// After an update, the Installed tab keeps whatever `packageUpdates` says: the
// "N updates available" badge and each row's version arrow come straight from
// it. A finished update that did not re-check left every package looking
// outdated until the user pressed Check updates by hand.

const INSTALLED: InstalledPackage[] = [
  { name: 'alpha', source: 'npm:alpha', type: 'package', version: '2.0.0', path: '/tmp/settings.json' },
]

let updates: PackageUpdate[] = []
let checks = 0
let mutationSucceeds = true

type AppStore = typeof import('./store')['useAppStore']
let useAppStore: AppStore

before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = {
    piDesktop: {
      packages: {
        listInstalled: async () => INSTALLED,
        checkUpdates: async () => {
          checks += 1
          return updates
        },
        updateAll: async () => ({ success: mutationSucceeds, output: mutationSucceeds ? '' : 'boom' }),
      },
    },
  }
  ;({ useAppStore } = await import('./store'))
})

beforeEach(() => {
  checks = 0
  mutationSucceeds = true
  updates = []
  useAppStore.setState({
    installedPackages: INSTALLED,
    packageUpdates: [{ source: 'npm:alpha', installedVersion: '1.0.0', latestVersion: '2.0.0' }],
    packageLoading: false,
    packageNotification: null,
  })
})

test('a finished update re-checks the registry so its badge clears', async () => {
  // Nothing is outdated any more — the point is that the answer is re-read
  // rather than assumed to be unchanged.
  await useAppStore.getState().updateAllPackages()
  assert.equal(checks, 1, 'the update re-checks the registry')
  assert.deepEqual(useAppStore.getState().packageUpdates, [])
})

test('a failed update still re-checks, because some package may have landed', async () => {
  mutationSucceeds = false
  await useAppStore.getState().updateAllPackages()
  assert.equal(checks, 1)
  assert.equal(useAppStore.getState().packageNotification?.type, 'error')
})

test('a restart shows as in flight on the packages page', async () => {
  let release: () => void = () => {}
  useAppStore.setState({
    piStatus: 'running',
    isStreaming: false,
    restartPi: async () => {
      await new Promise<void>((resolve) => { release = resolve })
    },
    refreshSessionState: async () => {},
    refreshSessionStats: async () => {},
    refreshSessionList: async () => {},
  })

  const restart = useAppStore.getState().restartEngine()
  // The confirm check is awaited first, so let the store reach the restart.
  await new Promise((resolve) => setTimeout(resolve, 0))
  // The banner renders from this flag; without it the button looked inert.
  assert.equal(useAppStore.getState().packageRestarting, true)
  release()
  await restart
  assert.equal(useAppStore.getState().packageRestarting, false)
})
