import { execFile, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { promisify } from 'util'
import type { AgentEngineKind } from '../../shared/ipc-contracts'
import { buildPiInvocation, buildPiRunEnv, getPiCli, getPiCliForEngine } from '../pi-rpc-manager'
import { describePiStartFailure } from '../pi-binary-resolution'
import { t } from '../../shared/i18n'

const execFileAsync = promisify(execFile)

export interface PiCliResult {
  success: boolean
  output: string
}

export interface PiCliStreamOptions {
  /** Called once per complete output line, already ANSI-stripped. */
  onLine?: (line: string) => void
  /** Aborts the child (and its process group) and resolves as cancelled. */
  signal?: AbortSignal
}

// The CLI colorizes its output; a renderer showing raw lines must not receive
// escape sequences. Covers the CSI/OSC/ESC forms chalk and npm emit. Built from
// String.fromCharCode because a literal control character in a regex trips
// ESLint's no-control-regex.
const ESC = String.fromCharCode(27)
const ANSI_PATTERN = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]` + // CSI: colors, cursor movement, erase
    `|${ESC}\\][^${String.fromCharCode(7)}]*${String.fromCharCode(7)}` + // OSC … BEL
    `|${ESC}[()#;?]?[0-9A-PR-TZcf-nq-uy=><~]?`, // short two-byte sequences
  'g',
)

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/** Split complete lines out of a growing buffer, keeping the trailing partial. */
export function takeLines(pending: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (pending + chunk).split('\n')
  const rest = parts.pop() ?? ''
  const lines: string[] = []
  for (const part of parts) {
    // A progress bar redraws with \r on one line; keep only the final state
    // rather than the accumulated garbage before it.
    const lastSegment = part.slice(Math.max(0, part.lastIndexOf('\r') + 1))
    const line = stripAnsi(lastSegment).trimEnd().slice(0, MAX_STREAMED_LINE_CHARS)
    if (line.length > 0 && line !== lines[lines.length - 1]) lines.push(line)
  }
  return { lines, rest }
}

/** Long enough for a real CLI message, short enough not to flood IPC. */
const MAX_STREAMED_LINE_CHARS = 400

/**
 * Run a `pi <subcommand>` using the same binary resolved at startup, or the
 * binary of an explicitly named engine (the active session's engine can differ
 * from the configured default when a session from the other store is open).
 * Electron's child processes don't inherit the user's shell PATH, so bare
 * `execFileAsync('pi', ...)` would fail with ENOENT on most systems.
 */
export async function runPiCli(
  args: string[],
  cwd: string,
  timeout: number,
  engine?: AgentEngineKind,
  options?: PiCliStreamOptions,
): Promise<PiCliResult> {
  return runPiCliStreaming(args, cwd, timeout, engine, options)
}

/**
 * The same run, but streaming: each output line reaches `onLine` as it arrives
 * instead of only at exit. Package updates can take minutes (npm installs, a
 * CLI self-update), so a UI that waits for the final result looks frozen.
 */
export function runPiCliStreaming(
  args: string[],
  cwd: string,
  timeout: number,
  engine?: AgentEngineKind,
  options: PiCliStreamOptions = {}
): Promise<PiCliResult> {
  try {
    const cli = engine ? getPiCliForEngine(engine) : getPiCli()
    // Nothing was found, so the invocation would be a bare name (`pi.cmd`,
    // `omp`, `node`), which Windows looks up in the working directory (the
    // workspace) before PATH. Report the start failure instead.
    if (cli.failureReason) {
      return Promise.resolve({ success: false, output: describePiStartFailure(cli.failureReason, t) })
    }
    // OMP keeps `install` as a Pi-compatible alias but names removal
    // explicitly. Preserve the package panel's existing contract while routing
    // that verb to OMP's native command. Updates differ per plugin kind under
    // OMP, so package-handlers builds those argv lists itself.
    const cliArgs = cli.kind === 'omp' && args[0] === 'remove'
      ? ['plugin', 'uninstall', ...args.slice(1)]
      : args
    // Package specs reach this argv from the renderer, and shell:true means
    // Node quotes nothing — buildPiInvocation escapes the whole invocation for
    // the cmd.exe traversal. A spec cmd.exe cannot carry throws here and is
    // reported through the same failure path as any other CLI error below.
    const invocation = buildPiInvocation(cli, cliArgs)

    // No line callback and no cancellation: keep the buffered execFile path,
    // which is what every non-UI caller (version probes) already used.
    if (!options.onLine && !options.signal) {
      return execFileAsync(invocation.file, invocation.args, {
        cwd,
        timeout,
        env: buildPiRunEnv(cli.needsShell),
        // Windows .cmd/.bat shims require shell:true to be invoked.
        shell: cli.needsShell,
      }).then(
        ({ stdout, stderr }) => ({ success: true, output: stdout + stderr }),
        (err: unknown) => ({ success: false, output: describeFailure(err) })
      )
    }

    return runStreaming(invocation, cwd, timeout, cli.needsShell, options)
  } catch (err) {
    return Promise.resolve({ success: false, output: describeFailure(err) })
  }
}

function describeFailure(err: unknown): string {
  // execFile rejections carry the child's stdout/stderr alongside the
  // message; surface all of it so the CLI's actual error reaches the user
  // instead of a bare "Command failed".
  const e = err as { stdout?: string; stderr?: string; message?: string }
  const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim()
  return output || t('errors.pi.commandFailedFallback')
}

function runStreaming(
  invocation: { file: string; args: string[] },
  cwd: string,
  timeout: number,
  needsShell: boolean,
  options: PiCliStreamOptions
): Promise<PiCliResult> {
  return new Promise<PiCliResult>((resolve) => {
    let output = ''
    let pending = ''
    let settled = false
    const child = spawn(invocation.file, invocation.args, {
      cwd,
      env: buildPiRunEnv(needsShell),
      shell: needsShell,
      windowsHide: true,
      // Its own group, so killChild's negative-PID signal reaches the npm and
      // node grandchildren a plain child.kill() leaves orphaned.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const emitLines = (chunk: string): void => {
      // Progress resets the inactivity budget: the number below bounds silence,
      // not total work. A `pi update --all` legitimately spends minutes inside
      // npm without printing a line, and a fixed total killed such a run the
      // moment it reached the half that replaces the CLI itself.
      if (chunk.length > 0) armTimeout()
      if (!options.onLine) {
        output += chunk
        return
      }
      const { lines, rest } = takeLines(pending, chunk)
      pending = rest
      for (const line of lines) {
        output += line + '\n'
        options.onLine(line)
      }
    }

    const finish = (result: PiCliResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      timer = undefined
      options.signal?.removeEventListener('abort', onAbort)
      // A trailing partial line is still output (chalk-free CLIs may not end
      // with a newline); report it so the last message is never swallowed.
      if (options.onLine && pending.trim().length > 0) {
        const line = stripAnsi(pending).trimEnd()
        output += line + '\n'
        if (line.length > 0) options.onLine(line)
        pending = ''
      }
      killChild(child)
      resolve(result)
    }

    const onAbort = (): void => finish({ success: false, output: output || t('errors.packages.updateCancelled') })
    options.signal?.addEventListener('abort', onAbort, { once: true })

    // A timeout must not look like silence: name the budget that ran out and
    // keep whatever the CLI already printed, so a run killed mid-way is
    // distinguishable from one that finished and did nothing.
    let timer: NodeJS.Timeout | undefined
    const armTimeout = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const budget = timeout >= 60_000
          ? t('errors.packages.updateTimedOut', { minutes: Math.round(timeout / 60_000) })
          : t('errors.packages.updateTimedOutSeconds', { seconds: Math.round(timeout / 1000) })
        finish({ success: false, output: output ? `${output}\n${budget}` : budget })
      }, timeout)
    }
    armTimeout()

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', emitLines)
    child.stderr?.on('data', emitLines)
    child.on('error', (err) => finish({ success: false, output: describeFailure(err) }))
    child.on('close', (code, signal) => {
      if (settled) return
      if (options.signal?.aborted) {
        finish({ success: false, output: output || t('errors.packages.updateCancelled') })
        return
      }
      const tail = pending.trim().length > 0 ? stripAnsi(pending).trim() : ''
      if (tail) output += tail
      if (code === 0) {
        finish({ success: true, output })
        return
      }
      const reason = signal ? `${signal}` : `code ${code ?? 'unknown'}`
      finish({ success: false, output: output || t('errors.packages.updateExited', { reason }) })
    })
  })
}

/** Kill the child and its group: npm spawns grandchildren that outlive a bare kill. */
function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
}
