import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldRunPiAutoUpdate } from './pi-auto-updater'

test('Pi auto-update runs only when pending, installed, not already running, and all runtimes stopped', () => {
  const base = { pending: true, running: false, piInstalled: true, runtimeStatuses: ['stopped'] }
  assert.equal(shouldRunPiAutoUpdate(base), true)
  assert.equal(shouldRunPiAutoUpdate({ ...base, pending: false }), false)
  assert.equal(shouldRunPiAutoUpdate({ ...base, running: true }), false)
  assert.equal(shouldRunPiAutoUpdate({ ...base, piInstalled: false }), false)
  assert.equal(shouldRunPiAutoUpdate({ ...base, runtimeStatuses: ['running'] }), false)
  assert.equal(shouldRunPiAutoUpdate({ ...base, runtimeStatuses: ['starting'] }), false)
})
