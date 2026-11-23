import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPiCli, stripAnsi, takeLines } from './run-pi-cli'
import { getPiCli, setPiExecutableOverride } from '../pi-rpc-manager'
import { describePiStartFailure } from '../pi-binary-resolution'
import { t } from '../../shared/i18n'

const CLI_TIMEOUT_MS = 10_000

test('a package command with no engine installed reports it instead of starting a bare name', async () => {
  // A configured OMP path that does not exist resolves to the bare `omp`
  // fallback. Spawned with the workspace as the working directory, Windows
  // would look that name up in the workspace first.
  const dir = mkdtempSync(join(tmpdir(), 'pi-cli-missing-'))
  const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL }
  try {
    // An empty PATH and no login shell: even a bare spawn could reach no real engine.
    process.env.PATH = dir
    process.env.SHELL = join(dir, 'no-such-shell')
    setPiExecutableOverride(join(dir, 'missing-omp'), 'omp')
    const { failureReason } = getPiCli()
    assert.ok(failureReason, 'the missing engine is a start failure')

    assert.deepEqual(await runPiCli(['--version'], dir, CLI_TIMEOUT_MS), {
      success: false,
      output: describePiStartFailure(failureReason, t),
    })
  } finally {
    setPiExecutableOverride(null, 'auto')
    process.env.PATH = saved.PATH
    if (saved.SHELL === undefined) delete process.env.SHELL
    else process.env.SHELL = saved.SHELL
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stripAnsi removes chalk colors but keeps the text', () => {
  assert.equal(stripAnsi('\u001b[32m+ added\u001b[39m'), '+ added')
  assert.equal(stripAnsi('\u001b[1m\u001b[31mERR\u001b[0m!'), 'ERR!')
  // OSC 8 hyperlinks (npm emits these) wrap the visible text.
  assert.equal(stripAnsi('\u001b]8;;https://x.dev\u0007link\u001b]8;;\u0007'), 'link')
})

test('takeLines emits complete lines and keeps the trailing partial', () => {
  const first = takeLines('', 'a\nb\nc')
  assert.deepEqual(first.lines, ['a', 'b'])
  assert.equal(first.rest, 'c')

  const second = takeLines(first.rest, 'd\ne\n')
  assert.deepEqual(second.lines, ['cd', 'e'])
  assert.equal(second.rest, '')
})

test('takeLines keeps only the final state of a \\r progress redraw', () => {
  // npm repaints one line: "0% 10% 50% 100%" is one line, not four.
  const { lines } = takeLines('', 'progress 10%\rprogress 90%\rprogress 100%\n')
  assert.deepEqual(lines, ['progress 100%'])
})

test('takeLines drops blank lines, repeats and over-long lines', () => {
  assert.deepEqual(takeLines('', '\n\n').lines, [])
  const long = 'x'.repeat(1_000)
  const [line] = takeLines('', `${long}\n`).lines
  assert.equal(line.length, 400)
})

test('a streamed run that exceeds its budget reports the timeout and keeps its output', async () => {
  // A real, slow-but-alive executable: the point is the timeout path, not the
  // CLI. `sleep` is on every POSIX system; the test is skipped on Windows.
  if (process.platform === 'win32') return
  const dir = mkdtempSync(join(tmpdir(), 'pi-cli-timeout-'))
  const script = join(dir, 'slow-pi.sh')
  writeFileSync(script, '#!/bin/sh\necho "starting work"\nsleep 30\n', { mode: 0o755 })
  const savedPath = process.env.PATH
  const savedShell = process.env.SHELL
  try {
    process.env.PATH = `${dir}:/usr/bin:/bin`
    process.env.SHELL = '/bin/sh'
    setPiExecutableOverride(script, 'pi')
    const lines: string[] = []
    // The budget must outlast process + shell startup so the first line lands
    // before the inactivity timer fires; the script then stays quiet for 30 s.
    const result = await runPiCli(['update', '--all'], dir, 2_500, 'pi', {
      onLine: (line) => lines.push(line),
    })
    assert.equal(result.success, false)
    // The partial output survives, so a killed run is not mistaken for silence.
    assert.match(result.output, /starting work/)
    assert.match(result.output, /timed out after 3 s|timed out after 2 s/)
    assert.deepEqual(lines, ['starting work'])
  } finally {
    setPiExecutableOverride(null, 'auto')
    process.env.PATH = savedPath
    if (savedShell === undefined) delete process.env.SHELL
    else process.env.SHELL = savedShell
    rmSync(dir, { recursive: true, force: true })
  }
})
