import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adjacentTabIndex, moveProjectTab, projectTabs } from './tab-navigation'
import { machineDisplayName, remoteProjectTabs, sessionTabs } from './session-tabs'
import { commandDisplayName, filterCommands } from '../../../shared/pi-command'
import type { PiCommand } from '../../../shared/pi-command'
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

function remoteRow(
  roomId: string,
  cwd: string,
  projectName: string,
  name: string,
  peer = 'peer',
): SessionListItem {
  return {
    path: `remote://${peer}/${roomId}`, name, preview: null, sessionId: roomId,
    lastModified: 0, messageCount: 1, projectPath: cwd, projectName,
    remote: { peer, roomId, hostname: 'mac' },
  }
}

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

test('every session on one machine is one project tab', () => {
  // The machine is the tab: two folders on the same Pi are chats of one
  // computer, not two projects sitting beside the local ones.
  const projects = remoteProjectTabs([
    remoteRow('room-a', '/Users/alandtse', 'alandtse', 'alandtse'),
    remoteRow('room-b', '/Users/alandtse', 'alandtse', 'alandtse#2'),
    remoteRow('room-c', '/Users/alandtse/open-shaders', 'open-shaders', 'open-shaders'),
  ])
  assert.equal(projects.length, 1)
  assert.deepEqual(projects[0].rows.map((row) => row.ref.roomId), ['room-a', 'room-b', 'room-c'])
  assert.deepEqual(projects[0].paths, ['/Users/alandtse', '/Users/alandtse/open-shaders'])
})

test('a remote tab is named after the machine, not a folder', () => {
  // Naming it after a folder made one machine look like several, and made two
  // of its sessions look like a project and a folder with the same name.
  const projects = remoteProjectTabs([remoteRow('room', 'C:/work/thing', 'thing', 'thing')])
  assert.equal(projects[0].title, 'mac')
  assert.equal(projects[0].id, 'remoteMachine:peer')
})

test('a Pi that never reported a hostname is named by a labelled key', () => {
  // `pair_ok` is the only frame carrying the hostname, so an existing pairing
  // has none. A bare key prefix reads as a name; labelling it does not.
  const projects = remoteProjectTabs([{
    path: 'remote://peer/room', name: 'chat', preview: null, sessionId: 'room',
    lastModified: 0, messageCount: 1, projectPath: '/Users/x', projectName: 'x',
    remote: { peer: 'abcdefghijkl', roomId: 'room' },
  }])
  assert.equal(projects[0].title, 'Paired Pi abcdefgh')
})

test('a remote chat hovers with its folder and its session name', () => {
  // The label is the session, so the folder has to live in the hover.
  const projects = remoteProjectTabs([remoteRow('room', '/Users/alandtse/open-shaders', 'open-shaders', 'open-shaders')])
  const tabs = sessionTabs({
    runtimes: {},
    workspaceId: undefined,
    sessionList: [],
    remoteRows: projects[0].rows,
    newSessionFallback: 'New',
  })
  assert.equal(tabs[0].title, 'open-shaders')
  assert.equal(tabs[0].tooltip, '/Users/alandtse/open-shaders (open-shaders)')
})

test('the chats of the machine on screen are session tabs beside local chats', () => {
  const runtimes = { local: runtime('local', 'project', '/local') }
  const machine = remoteProjectTabs([
    remoteRow('room-a', '/Users/alandtse', 'alandtse', 'alandtse'),
    remoteRow('room-b', '/Users/alandtse/open-shaders', 'open-shaders', 'open-shaders'),
  ])
  const tabs = sessionTabs({
    runtimes,
    workspaceId: 'project',
    sessionList: [],
    remoteRows: machine[0].rows,
    newSessionFallback: 'New',
  })
  assert.deepEqual(tabs.map((tab) => tab.id), ['remote:peer:room-a', 'remote:peer:room-b', 'local'])
  // A chat is named by its session: the folder is the same for its siblings.
  assert.deepEqual(tabs.slice(0, 2).map((tab) => tab.title), ['alandtse', 'open-shaders'])
})
test('a local chat does not stand beside the chats of a remote machine', () => {
  // The strip is the chats of the project ON SCREEN. While a remote machine is
  // on screen its rows are the whole strip; the local project is not shown, so
  // one of its chats appearing here was an extra tab that opened the wrong view.
  const runtimes = { local: runtime('local', 'project', '/local') }
  const machine = remoteProjectTabs([remoteRow('room-a', '/Users/alandtse', 'alandtse', 'alandtse')])
  const remoteOnly = sessionTabs({
    runtimes,
    workspaceId: undefined,
    sessionList: [],
    remoteRows: machine[0].rows,
    newSessionFallback: 'New',
  })
  assert.deepEqual(remoteOnly.map((tab) => tab.id), ['remote:peer:room-a'])
})

test('a machine is named the same way wherever it is shown', () => {
  // The tab and the sidebar heading drifted: the tab used the machine's hostname
  // while the heading used the Pi's agent name, which names a session and repeats
  // across a machine's sessions. Both now call this, so they cannot disagree.
  const peer = 'hKqfHH3rUAvSuwGI9yam2BkM5DCiiGlIgs53wFR+SiQ='
  assert.equal(
    machineDisplayName({ machineName: 'MacBookPro.lan', peer }),
    'MacBookPro.lan',
    'the reported hostname wins',
  )

  // A name the user typed outranks everything, because it is the only input that
  // is available even when the pairing predates the hostname field.
  assert.equal(
    machineDisplayName({ machineAlias: ' Mac ', machineName: 'MacBookPro.lan', peer }),
    'Mac',
    'a typed alias wins over the reported hostname',
  )
  assert.equal(machineDisplayName({ machineAlias: 'Mac', peer }), 'Mac', 'an alias stands alone')
  // The Pi's agent name is NOT a machine name: it names a session, and using it
  // is what made one machine show up as "open-shaders" in the sidebar.
  assert.equal(
    machineDisplayName({ agentName: 'open-shaders', peer } as never),
    'Paired Pi hKqfHH3r',
    'a session-shaped agent name is never used as the machine name',
  )
  // A name belongs to the MACHINE, so two machines can carry their own.
  const rows = [
    remoteRow('room-a', '/Users/a', 'a', 'a', 'peerA'),
    remoteRow('room-b', '/Users/b', 'b', 'b', 'peerB'),
  ]
  const projects = remoteProjectTabs(rows, { peerA: 'Studio Mac', peerB: 'Laptop' })
  assert.deepEqual(projects.map((p) => p.title).sort(), ['Laptop', 'Studio Mac'])

  // The Pi's agent name must never be used: it names a session, so one machine
  // showed up as "open-shaders" — the label the user reported as wrong.
  assert.equal(
    machineDisplayName({ peer }),
    'Paired Pi hKqfHH3r',
    'a pairing with no hostname falls back to the key, not the session name',
  )

  // Nothing but a key: say so rather than showing a bare token as if it were a name.
  assert.equal(machineDisplayName({}), 'remote')
})

test('a slash token finds the engine commands including skills and extensions', () => {
  // Measured against the real engine, which reports 128 commands: 86 extensions,
  // 31 skills, 11 prompts. The composer offered none of them because the catalog
  // was only loaded on a live status event, so this pins the matching behaviour
  // for the two kinds the user reported missing.
  const catalog: PiCommand[] = [
    { name: 'btw', description: 'Continue a side conversation', source: 'extension' },
    { name: 'side', description: 'Alias for /btw', source: 'extension' },
    { name: 'skill:caveman', description: 'Ultra-compressed mode', source: 'skill' },
    { name: 'skill:find-skills', description: 'Discover skills', source: 'skill' },
  ]
  assert.equal(filterCommands(catalog, '/btw')[0].name, 'btw')
  assert.equal(filterCommands(catalog, '/caveman')[0].name, 'skill:caveman', 'a skill is found by its bare name')
  assert.equal(filterCommands(catalog, '/find-skills')[0].name, 'skill:find-skills')

  // A skill shows without the redundant "skill:" prefix, which is what the
  // command list renders.
  assert.equal(commandDisplayName(catalog[2]), 'caveman')
})
