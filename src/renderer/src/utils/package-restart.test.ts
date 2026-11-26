import assert from 'node:assert/strict'
import test from 'node:test'

import { packageRestartNeed } from './package-restart'

test('a running engine is offered a restart', () => {
  assert.equal(packageRestartNeed({ changed: true, piStatus: 'running' }), 'restart')
})

test('an engine that is not running is not offered a pointless restart', () => {
  // The next message starts it, and the start reads the new packages. Telling the
  // user to restart something that is already stopped reads as a broken banner.
  assert.equal(packageRestartNeed({ changed: true, piStatus: 'stopped' }), 'nothingRunning')
  assert.equal(packageRestartNeed({ changed: true, piStatus: 'error' }), 'nothingRunning')
})

test('a starting engine is not restarted under itself', () => {
  assert.equal(packageRestartNeed({ changed: true, piStatus: 'starting' }), 'busy')
})

test('a failed operation offers nothing', () => {
  assert.equal(packageRestartNeed({ changed: false, piStatus: 'running' }), null)
  assert.equal(packageRestartNeed({ changed: false, piStatus: 'stopped' }), null)
})
