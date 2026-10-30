import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TODO_STATE_ENTRY_TYPE,
  activeTask,
  foldTodoEvent,
  readTodoSnapshot,
  remainingCount,
  todoCounts,
  visibleTasks,
  type TodoSourceEntry,
} from './todo-state'

const TASKS = [
  { id: 1, subject: 'Map the pipeline', status: 'completed' as const },
  { id: 2, subject: 'Render the rows', status: 'in_progress' as const, activeForm: 'rendering rows' },
  { id: 3, subject: 'Swap and verify', status: 'pending' as const },
]

/** A `custom` branch entry, the shape `pi.appendEntry` writes. */
function entry(tasks: typeof TASKS, nextId = 4): TodoSourceEntry {
  return { type: 'custom', customType: TODO_STATE_ENTRY_TYPE, data: { tasks, nextId } }
}

/** The live event pi streams for the same write. */
function appended(tasks: typeof TASKS, nextId = 4): TodoSourceEntry {
  return {
    type: 'entry_appended',
    entry: { customType: TODO_STATE_ENTRY_TYPE, data: { tasks, nextId } },
  } as TodoSourceEntry
}

/** A `todo` tool result, the only source in sessions written before entries existed. */
function toolResult(tasks: typeof TASKS): TodoSourceEntry {
  return {
    type: 'message',
    message: { role: 'toolResult', toolName: 'todo', details: { tasks, nextId: 4 } },
  }
}

test('the live event and the replayed entry both yield the list', () => {
  const fromLive = foldTodoEvent(null, appended(TASKS))
  const fromFile = foldTodoEvent(null, entry(TASKS))

  for (const snapshot of [fromLive, fromFile]) {
    assert.deepEqual(visibleTasks(snapshot).map((task) => task.subject), [
      'Map the pipeline',
      'Render the rows',
      'Swap and verify',
    ])
    assert.equal(snapshot?.fromEntry, true, 'an entry is authoritative')
  }
})

test('a reload ends on the last change, not the first', () => {
  // rpiv-todo writes the whole snapshot on every change, so replaying must take the
  // last one. Freezing on the first would show a task list the agent finished with.
  let snapshot = null
  snapshot = foldTodoEvent(snapshot, entry(TASKS))
  snapshot = foldTodoEvent(
    snapshot,
    entry([{ id: 1, subject: 'Map the pipeline', status: 'completed' }], 4),
  )

  assert.deepEqual(visibleTasks(snapshot).map((task) => task.status), ['completed'])
  assert.equal(remainingCount(visibleTasks(snapshot)), 0)
})

test('a tool result is the only source in an older session, and a later one wins', () => {
  // Sessions written before rpiv-todo appended entries carry only tool results.
  let snapshot = null
  snapshot = foldTodoEvent(snapshot, toolResult([{ id: 1, subject: 'First', status: 'pending' }]))
  assert.deepEqual(visibleTasks(snapshot).map((task) => task.subject), ['First'])

  snapshot = foldTodoEvent(
    snapshot,
    toolResult([{ id: 1, subject: 'First', status: 'completed' }, { id: 2, subject: 'Second', status: 'pending' }]),
  )
  assert.equal(visibleTasks(snapshot).length, 2, 'the later tool result replaces the earlier one')
})

test('a tool result cannot overtake an entry', () => {
  // Both carry the same envelope; the entry is written at commit time for every
  // change, so a tool result can only repeat or predate it.
  const withEntry = foldTodoEvent(null, entry(TASKS))
  const afterToolResult = foldTodoEvent(withEntry, toolResult([{ id: 9, subject: 'Stale', status: 'pending' }]))

  assert.equal(afterToolResult, null, 'the tool result contributes nothing')
})

test('an unrelated message does not disturb the panel', () => {
  const snapshot = foldTodoEvent(null, entry(TASKS))
  const untouched = [
    { type: 'message', message: { role: 'assistant', content: 'hello' } },
    { type: 'status_change', status: 'running' } as TodoSourceEntry,
    { type: 'custom', customType: 'something-else', data: { tasks: [] } } as TodoSourceEntry,
  ]
  for (const event of untouched) {
    assert.equal(foldTodoEvent(snapshot, event), null, `${JSON.stringify(event)} says nothing about tasks`)
  }
})

test('a deleted task is kept out of the panel but does not corrupt the list', () => {
  // rpiv-todo marks a task `deleted` as a tombstone rather than removing it; showing it
  // would contradict what the agent believes its list to be.
  const snapshot = foldTodoEvent(
    null,
    entry([
      ...TASKS.slice(0, 2),
      { id: 3, subject: 'Dropped', status: 'deleted' as const },
    ] as typeof TASKS),
  )
  assert.equal(visibleTasks(snapshot).length, 2)
  assert.deepEqual(todoCounts(visibleTasks(snapshot)), { total: 2, remaining: 1, done: 1 })
})

test('a malformed payload leaves the panel alone instead of blanking it', () => {
  assert.equal(readTodoSnapshot(null), null)
  assert.equal(readTodoSnapshot({}), null)
  assert.equal(readTodoSnapshot({ tasks: 'not an array' }), null)
  assert.equal(readTodoSnapshot({ tasks: [{ id: 'x', subject: 1, status: 'nope' }] })?.tasks.length, 0)
})

test('the active task is the one being worked on', () => {
  const tasks = visibleTasks(foldTodoEvent(null, entry(TASKS)))
  assert.equal(activeTask(tasks)?.subject, 'Render the rows')
  assert.equal(activeTask([]), null)
})
