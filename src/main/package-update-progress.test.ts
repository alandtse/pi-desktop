import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PackageUpdateProgress } from '../shared/ipc-contracts'
import {
  beginPackageUpdate,
  cancelPackageUpdate,
  endPackageUpdate,
  getActivePackageUpdateRun,
  setPackageUpdateEmitter,
  updatePackageProgress,
} from './package-update-progress'

function collector(): { events: PackageUpdateProgress[]; restore: () => void } {
  const events: PackageUpdateProgress[] = []
  setPackageUpdateEmitter((progress) => events.push(progress))
  return { events, restore: () => setPackageUpdateEmitter(() => {}) }
}

test('a run reports preparing, its steps and then done', () => {
  const { events, restore } = collector()
  try {
    const run = beginPackageUpdate('pi', 'all')
    updatePackageProgress(run, { phase: 'waiting-for-runtimes', waitingRuntimes: 2 })
    updatePackageProgress(run, { phase: 'output', line: 'updating pi' })
    endPackageUpdate(run, { success: true })

    assert.deepEqual(events.map((event) => event.phase), [
      'preparing',
      'waiting-for-runtimes',
      'output',
      'done',
    ])
    assert.equal(events[1].waitingRuntimes, 2)
    assert.equal(events[1].target, 'all')
    assert.equal(events[1].engine, 'pi')
    assert.equal(events[2].line, 'updating pi')
    assert.equal(events[3].success, true)
    assert.equal(getActivePackageUpdateRun(), null, 'a finished run is no longer active')
  } finally {
    restore()
  }
})

test('a step can rename the target so "update all" shows the package in flight', () => {
  const { events, restore } = collector()
  try {
    const run = beginPackageUpdate('omp', 'all')
    updatePackageProgress(run, { phase: 'running', target: 'pi-subagents', completed: 1, total: 3 })
    assert.equal(events[1].target, 'pi-subagents')
    assert.equal(events[1].completed, 1)
    assert.equal(events[1].total, 3)
    endPackageUpdate(run, { success: true })
  } finally {
    restore()
  }
})

test('cancelling aborts the run and reports it once', () => {
  const { events, restore } = collector()
  try {
    const run = beginPackageUpdate('pi', 'all')
    assert.equal(cancelPackageUpdate(), true)
    assert.equal(run.controller.signal.aborted, true)
    assert.equal(events[events.length - 1].phase, 'cancelled')
    assert.equal(getActivePackageUpdateRun(), null)
    // Nothing left to cancel.
    assert.equal(cancelPackageUpdate(), false)
    // A late line from the cancelled run must not resurrect it.
    const before = events.length
    updatePackageProgress(run, { phase: 'output', line: 'late' })
    assert.equal(events.length, before)
    endPackageUpdate(run, { success: true })
    assert.equal(events.length, before)
  } finally {
    restore()
  }
})

test('a new run aborts the previous one and ignores its late events', () => {
  const { events, restore } = collector()
  try {
    const first = beginPackageUpdate('pi', 'npm:one')
    const second = beginPackageUpdate('pi', 'npm:two')
    assert.equal(first.controller.signal.aborted, true)
    assert.equal(getActivePackageUpdateRun()?.runId, second.runId)

    const before = events.length
    updatePackageProgress(first, { phase: 'output', line: 'stale' })
    endPackageUpdate(first, { success: true })
    assert.equal(events.length, before, 'the superseded run is silent')

    updatePackageProgress(second, { phase: 'output', line: 'fresh' })
    assert.equal(events[events.length - 1].line, 'fresh')
    endPackageUpdate(second, { success: false, error: 'boom' })
    assert.equal(events[events.length - 1].error, 'boom')
  } finally {
    restore()
  }
})