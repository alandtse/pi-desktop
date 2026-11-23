import { before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PiProcessStatus } from '../../shared/ipc-contracts'

// The restart path is thin but load-bearing: it is the only way the user can
// make a freshly installed package take effect, and it must never restart into
// a stopped engine (the IPC requires a live runtime) nor discard a running turn
// without asking first.
let restartCalls = 0
let startCalls = 0

type AppStore = typeof import('./store')['useAppStore']
let useAppStore: AppStore

before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = {
    piDesktop: {
      pi: {
        restart: async () => {
          restartCalls += 1
          return { status: 'running' as const, pid: 123, error: null, engine: 'pi' as const }
        },
        start: async () => {
          startCalls += 1
          return { status: 'running' as const, pid: 124, error: null, engine: 'pi' as const }
        },
      },
    },
  }
  ;({ useAppStore } = await import('./store'))
})

beforeEach(() => {
  restartCalls = 0
  startCalls = 0
  useAppStore.setState({
    piStatus: 'running' as PiProcessStatus,
    isStreaming: false,
    // The restart re-reads session state; those calls are irrelevant here.
    refreshSessionState: async () => {},
    refreshSessionStats: async () => {},
    refreshSessionList: async () => {},
  })
})

test('restarting a live engine asks the IPC to restart it', async () => {
  await useAppStore.getState().restartEngine()
  assert.equal(restartCalls, 1)
  assert.equal(startCalls, 0)
})

test('a stopped engine is started, not restarted', async () => {
  // `pi:restart` throws without a live runtime, so the action must branch.
  useAppStore.setState({ piStatus: 'stopped' })
  await useAppStore.getState().restartEngine()
  assert.equal(restartCalls, 0)
  assert.equal(startCalls, 1)
})

test('a running turn is confirmed before it is discarded', async () => {
  let asked = false
  let confirmed = false
  useAppStore.setState({
    isStreaming: true,
    requestConfirm: async () => {
      asked = true
      return confirmed
    },
  })

  await useAppStore.getState().restartEngine()
  assert.equal(asked, true, 'the user is told the turn will be discarded')
  assert.equal(restartCalls, 0, 'declining leaves the engine alone')

  confirmed = true
  await useAppStore.getState().restartEngine()
  assert.equal(restartCalls, 1)
})
