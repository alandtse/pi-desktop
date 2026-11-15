import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSubagentTool as isLocalSubagentTool,
  subagentAgentName as localSubagentAgentName,
  subagentTaskText as localSubagentTaskText,
} from '../subagent-task'
import {
  isSubagentTool as isRemoteSubagentTool,
  subagentAgentName as remoteSubagentAgentName,
  subagentTaskText as remoteSubagentTaskText,
} from './subagent-progress'

const implementations = [
  {
    label: 'local task tracking',
    isSubagentTool: isLocalSubagentTool,
    subagentAgentName: localSubagentAgentName,
    subagentTaskText: localSubagentTaskText,
  },
  {
    label: 'shared stream progress',
    isSubagentTool: isRemoteSubagentTool,
    subagentAgentName: remoteSubagentAgentName,
    subagentTaskText: remoteSubagentTaskText,
  },
] as const

for (const implementation of implementations) {
  const { label, isSubagentTool, subagentAgentName, subagentTaskText } = implementation

  test(`${label}: both engines' spawn tools are recognized`, () => {
    assert.equal(isSubagentTool('subagent'), true)
    assert.equal(isSubagentTool('subagent_wait'), true)
    // The regression: OMP's spawn tools used to fall through unrecognized.
    assert.equal(isSubagentTool('task'), true)
    // `hub` fans out several agents when a plain reviewer request is used.
    assert.equal(isSubagentTool('hub'), true)
  })

  test(`${label}: ordinary tools are not treated as spawns`, () => {
    for (const name of ['read', 'grep', 'glob', 'bash', 'edit', 'write', 'todo', 'eval']) {
      assert.equal(isSubagentTool(name), false, `${name} must not be a spawn`)
    }
  })

  test(`${label}: the agent label is read from whichever key the engine used`, () => {
    assert.equal(subagentAgentName({ agent: 'reviewer' }), 'reviewer')
    assert.equal(subagentAgentName({ agentType: 'scout' }), 'scout')
    assert.equal(subagentAgentName({ subagent_type: 'librarian' }), 'librarian')
  })

  test(`${label}: an unlabelled spawn still gets a row rather than being dropped`, () => {
    assert.equal(subagentAgentName({}), 'subagent')
    assert.equal(subagentAgentName(undefined), 'subagent')
    // Whitespace is not a label.
    assert.equal(subagentAgentName({ agent: '   ' }), 'subagent')
  })

  test(`${label}: the task caption is read from whichever key the engine used`, () => {
    assert.equal(subagentTaskText({ task: 'audit the parser' }), 'audit the parser')
    assert.equal(subagentTaskText({ prompt: 'audit the parser' }), 'audit the parser')
    assert.equal(subagentTaskText({ description: 'audit the parser' }), 'audit the parser')
    assert.equal(subagentTaskText({}), '')
  })

  test(`${label}: the first matching key wins so a label is stable`, () => {
    assert.equal(subagentAgentName({ agent: 'reviewer', agentType: 'scout' }), 'reviewer')
    assert.equal(subagentTaskText({ task: 'first', prompt: 'second' }), 'first')
  })

  test(`${label}: non-string arguments never leak into the label`, () => {
    assert.equal(subagentAgentName({ agent: 42 } as Record<string, unknown>), 'subagent')
    assert.equal(subagentTaskText({ task: { nested: true } } as Record<string, unknown>), '')
  })
}
