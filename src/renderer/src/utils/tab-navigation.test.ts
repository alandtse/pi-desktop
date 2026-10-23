import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adjacentTabIndex, moveProjectTab, projectTabs } from './tab-navigation'
import { remoteProjectTabs, sessionTabs } from './session-tabs'
import type { SessionListItem, SessionRuntimeInfo, Workspace } from '../../../shared/ipc-contracts'

const workspace = (id: string, createdAt: number): Workspace => ({ id, createdAt, name: id, path: `/${id}`, lastActiveAt: 0, color: '' })
const runtime = (runtimeId: string, workspaceId: string, sessionPath: string | null): SessionRuntimeInfo => ({
  runtimeId, workspaceId, sessionPath, sessionId: null, activity: null, active: false, status: 'running', pid: null, error: null,
})

test('navigation wraps in both directions and handles empty or unselected tabs', () => {
  assert.equal(adjacentTabIndex(0, 3, 'next'), 1)
  assert.equal(adjacentTabIndex(2, 3, 'next'), 0)
  assert.equal(adjacentTabIndex(2, 3, 'previous'), 1)
  assert.equal(adjacentTabIndex(0, 3, 'previous'), 2)
  for (const direction of ['previous', 'next'] as const) {
    assert.equal(adjacentTabIndex(-1, 0, direction), null)
    assert.equal(adjacentTabIndex(0, 1, direction), 0)
  }
  assert.equal(adjacentTabIndex(-1, 3, 'next'), 0)
  assert.equal(adjacentTabIndex(-1, 3, 'previous'), 2)
})

test('project order follows creation time, not recent activation, without mutating the store list', () => {
  const workspaces = [workspace('c', 3), workspace('a', 1), workspace('b', 2)]
  workspaces[0].lastActiveAt = 100
  assert.deepEqual(projectTabs(workspaces).map((tab) => tab.id), ['a', 'b', 'c'])
  assert.deepEqual(workspaces.map((tab) => tab.id), ['c', 'a', 'b'])
})

test('custom project order survives recent activation, ignores closed projects and appends new ones', () => {
  const workspaces = [workspace('newer', 5), workspace('a', 1), workspace('b', 2), workspace('new', 4)]
  const order = ['b', 'closed', 'a']
  workspaces[1].lastActiveAt = 100
  assert.deepEqual(projectTabs(workspaces, order).map((tab) => tab.id), ['b', 'a', 'new', 'newer'])
  assert.deepEqual(order, ['b', 'closed', 'a'])
})

test('moving a project inserts before or after the target in either direction without mutation', () => {
  const order = ['a', 'b', 'c', 'd']
  assert.deepEqual(moveProjectTab(order, 'a', 'c', 'before'), ['b', 'a', 'c', 'd'])
  assert.deepEqual(moveProjectTab(order, 'a', 'd', 'after'), ['b', 'c', 'd', 'a'])
  assert.deepEqual(moveProjectTab(order, 'd', 'a', 'before'), ['d', 'a', 'b', 'c'])
  assert.deepEqual(moveProjectTab(order, 'd', 'b', 'after'), ['a', 'b', 'd', 'c'])
  assert.deepEqual(order, ['a', 'b', 'c', 'd'])
  for (const placement of ['before', 'after'] as const) {
    assert.equal(moveProjectTab(order, 'a', 'a', placement), order)
    assert.equal(moveProjectTab(order, 'closed', 'a', placement), order)
    assert.equal(moveProjectTab(order, 'a', 'closed', placement), order)
  }
})

test('session order includes only open tabs in this project, newest first', () => {
  const runtimes = {
    first: runtime('first', 'project', '/first'),
    other: runtime('other', 'other-project', '/other'),
    starting: runtime('starting', 'project', null),
    last: runtime('last', 'project', '/last'),
  }
  const rows: SessionListItem[] = [
    { path: '/first', name: 'First', preview: null, sessionId: 's1', lastModified: 0, messageCount: 0, projectPath: '/p', projectName: 'p' },
    { path: '/last', name: 'Last', preview: null, sessionId: 's2', lastModified: 0, messageCount: 0, projectPath: '/p', projectName: 'p' },
  ]
  const tabs = () => sessionTabs({ runtimes, workspaceId: 'project', sessionList: rows, newSessionFallback: 'New' })
  assert.deepEqual(tabs().map((tab) => tab.id), ['last', 'first'])
  assert.deepEqual(tabs().map((tab) => tab.title), ['Last', 'First'])
  runtimes.first.active = true
  assert.deepEqual(tabs().map((tab) => tab.id), ['last', 'first'])
  assert.deepEqual(
    sessionTabs({ runtimes, workspaceId: undefined, sessionList: rows, newSessionFallback: 'New' }).map((tab) => tab.id),
    [],
  )
})

const remoteRow = (roomId: string, cwd: string, projectName: string, name: string): SessionListItem => ({
  path: `remote://peer/${roomId}`, name, preview: null, sessionId: roomId,
  lastModified: 0, messageCount: 1, projectPath: cwd, projectName,
  remote: { peer: 'peer', roomId, hostname: 'mac' },
})

test('a remote session is not a chat inside a local project', () => {
  // A chat in the strip belongs to the project on screen; a session on the other
  // machine belongs to a folder there, so putting it here said it was local.
  const runtimes = { local: runtime('local', 'project', '/local') }
  const rows: SessionListItem[] = [
    { path: '/local', name: 'Local chat', preview: null, sessionId: 'l1', lastModified: 0, messageCount: 0, projectPath: '/p', projectName: 'p' },
    remoteRow('room', '/Users/alandtse', 'alandtse', 'Mac chat'),
  ]
  const tabs = sessionTabs({ runtimes, workspaceId: 'project', sessionList: rows, newSessionFallback: 'New' })
  assert.deepEqual(tabs.map((tab) => tab.id), ['local'])
})

test('the sessions of one remote folder form one project tab', () => {
  // Two sessions from the same folder are two chats in one project, exactly as
  // they would be locally.
  const projects = remoteProjectTabs([
    remoteRow('room-a', '/Users/alandtse', 'alandtse', 'alandtse'),
    remoteRow('room-b', '/Users/alandtse', 'alandtse', 'alandtse#2'),
    remoteRow('room-c', '/Users/alandtse/open-shaders', 'open-shaders', 'open-shaders'),
  ])
  assert.equal(projects.length, 2)
  assert.equal(projects[0].title, 'alandtse')
  assert.deepEqual(projects[0].rows.map((row) => row.ref.roomId), ['room-a', 'room-b'])
  assert.equal(projects[0].hostname, 'mac')
  assert.equal(projects[1].title, 'open-shaders')
  assert.deepEqual(projects[1].rows.map((row) => row.ref.roomId), ['room-c'])
})

test('a remote project tab is named after the folder, not the machine', () => {
  const projects = remoteProjectTabs([remoteRow('room', 'C:/work/thing', 'thing', 'thing')])
  assert.equal(projects[0].title, 'thing')
  assert.equal(projects[0].id, 'remoteProject:peer:C:/work/thing')
})

test('a Windows folder path on the other machine still yields a folder name', () => {
  // The roster can name a folder with backslashes; the tab shows its last part.
  const projects = remoteProjectTabs([remoteRow('room', 'C:\\work\\thing', 'thing', 'thing')])
  assert.equal(projects[0].title, 'thing')
})