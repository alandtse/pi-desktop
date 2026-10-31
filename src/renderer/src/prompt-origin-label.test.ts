import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionListItem } from '../../shared/ipc-contracts'
import { promptOriginLabel } from './prompt-origin-label'

function remoteRow(peer: string, roomId: string, name: string, folder: string): SessionListItem {
  // Built as the full shape the list carries; only the fields this label reads
  // matter, but a partial object cannot be cast without hiding a real drift.
  return {
    path: `remote://${peer}/${roomId}`,
    name,
    preview: '',
    sessionId: roomId,
    projectName: folder,
    projectPath: folder,
    lastModified: 0,
    messageCount: 0,
    contentState: 'non-empty' as const,
    remote: { peer, roomId, hostname: 'mac' },
  }
}

test('a local prompt has no origin label', () => {
  // A prompt from this machine's Pi belongs to the chat on screen by definition;
  // labelling it would say "asked by" about the session already being read.
  assert.equal(promptOriginLabel(null, []), null)
  assert.equal(promptOriginLabel(undefined, []), null)
  assert.equal(promptOriginLabel({ peer: '', roomId: '' }, []), null)
})

test('a listed remote session is named the way its tab is', () => {
  const rows = [remoteRow('PEERKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'room-7', 'refactor', '/Users/a/b')]
  assert.equal(
    promptOriginLabel({ peer: 'PEERKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', roomId: 'room-7' }, rows),
    '/Users/a/b (refactor)',
  )
})

test('an unknown room falls back to ids rather than showing nothing', () => {
  // The room may be closed, or its roster may not have arrived: the dialog still
  // has to distinguish this prompt from one in the chat on screen.
  assert.equal(
    promptOriginLabel({ peer: 'ABCDEFGHIJKLMNOP', roomId: 'room-9' }, []),
    'ABCDEFGH / room-9',
  )
})

test('the same room id on two machines is not confused', () => {
  // Room ids come from the Pi and are only unique per machine, so a label must
  // match on the peer too or it would name the wrong session.
  const rows = [
    remoteRow('MAC-PEER-KEY', 'room-1', 'on-the-mac', '/Users/a'),
    remoteRow('LINUX-PEER-KEY', 'room-1', 'on-the-linux', '/home/a'),
  ]
  assert.equal(promptOriginLabel({ peer: 'LINUX-PEER-KEY', roomId: 'room-1' }, rows), '/home/a (on-the-linux)')
  assert.equal(promptOriginLabel({ peer: 'MAC-PEER-KEY', roomId: 'room-1' }, rows), '/Users/a (on-the-mac)')
})

test('a room id with no peer still resolves through its row', () => {
  const rows = [remoteRow('PEER-A', 'room-3', 'only', '/w')]
  assert.equal(promptOriginLabel({ peer: '', roomId: 'room-3' }, rows), '/w (only)')
})
