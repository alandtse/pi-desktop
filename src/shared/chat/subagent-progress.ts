/** Longest caption kept for one child row of a parallel or chained spawn. */
const SUBAGENT_CHILD_TASK_PREVIEW_CHARS = 160

export interface SubagentChildProgress {
  id: string
  agent: string
  status: string
  task: string
  toolCount: number
  tokens: number
  durationMs: number
  currentTool?: string
}

export interface SubagentProgress {
  toolCallId: string
  agent: string
  status: string
  task: string
  toolCount: number
  tokens: number
  turnCount?: number
  durationMs: number
  currentTool?: string
  /** Parallel/chain children when the tool streams a progress list. */
  children?: SubagentChildProgress[]
}

/**
 * Tool names that spawn a subagent.
 *
 * Pi delegates through the `pi-subagents` package, which registers `subagent`
 * and `subagent_wait`. OMP has delegation built in and groups it under
 * coordination as `task` (delegate one) and `hub` (fan out to several); `hub`
 * is what a plain "use the reviewer agent" request actually calls, observed on
 * the wire. The strip keyed off the Pi names only, so under OMP it stayed
 * empty while five reviewers really were running.
 */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['subagent', 'subagent_wait', 'task', 'hub'])

export function isSubagentTool(toolName: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(toolName)
}

/**
 * First non-empty string among `keys`, or null.
 *
 * The two engines label a spawn with different argument names and OMP's schema
 * is not published anywhere this code can read, so the label is resolved by
 * trying the plausible keys rather than hard-coding one engine's spelling. A
 * miss costs a generic label, never a missing progress row.
 */
function firstStringArg(args: Record<string, unknown> | undefined, keys: readonly string[]): string | null {
  if (!args) return null
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

/** Which agent a spawn targets. Both engines have used `agent`; the rest are fallbacks. */
export function subagentAgentName(args: Record<string, unknown> | undefined): string {
  return firstStringArg(args, ['agent', 'agentType', 'subagent_type', 'name', 'type']) ?? 'subagent'
}

/** The instruction given to the spawn, used as the row's caption. */
export function subagentTaskText(args: Record<string, unknown> | undefined): string {
  return firstStringArg(args, ['task', 'prompt', 'description', 'instructions', 'message']) ?? ''
}

/** Fold tool details.progress / results into a single progress row (+ children). */
export function aggregateSubagentDetails(
  prev: SubagentProgress,
  progressList: Array<Record<string, unknown>> | undefined,
  results: Array<Record<string, unknown>> | undefined
): Partial<SubagentProgress> {
  let toolCount = 0
  let tokens = 0
  let durationMs = 0
  let currentTool: string | undefined
  const statuses: string[] = []
  const children: SubagentChildProgress[] = []

  if (progressList) {
    progressList.forEach((prog, index) => {
      const tc = typeof prog.toolCount === 'number' ? prog.toolCount : 0
      const tok = typeof prog.tokens === 'number' ? prog.tokens : 0
      const dur = typeof prog.durationMs === 'number' ? prog.durationMs : 0
      toolCount += tc
      tokens += tok
      durationMs = Math.max(durationMs, dur)
      if (typeof prog.status === 'string') statuses.push(prog.status)
      const tool =
        typeof prog.currentTool === 'string'
          ? prog.currentTool
          : typeof prog.tool === 'string'
            ? prog.tool
            : undefined
      if (tool) currentTool = tool

      const agent =
        typeof prog.agent === 'string'
          ? prog.agent
          : typeof prog.name === 'string'
            ? prog.name
            : prev.agent
      const task =
        typeof prog.task === 'string'
          ? prog.task
          : typeof prog.label === 'string'
            ? prog.label
            : ''
      const st = typeof prog.status === 'string' ? prog.status : 'running'
      const id =
        typeof prog.id === 'string'
          ? prog.id
          : typeof prog.runId === 'string'
            ? prog.runId
            : `${prev.toolCallId}-${index}`

      children.push({
        id,
        agent,
        status: st === 'completed' || st === 'done' ? 'done' : st === 'failed' || st === 'error' ? 'error' : 'running',
        task: task.slice(0, SUBAGENT_CHILD_TASK_PREVIEW_CHARS),
        toolCount: tc,
        tokens: tok,
        durationMs: dur,
        currentTool: tool,
      })
    })
  }

  if (results) {
    for (const r of results) {
      const usage = r.usage as Record<string, number> | undefined
      if (usage) {
        tokens += (usage.input ?? 0) + (usage.output ?? 0)
      }
    }
  }

  const running = statuses.some((s) => s === 'running' || s === 'starting')
  const allDone =
    statuses.length > 0 &&
    statuses.every((s) => s === 'completed' || s === 'failed' || s === 'done' || s === 'error' || s === 'stopped')

  return {
    status: allDone ? 'done' : running ? 'running' : prev.status,
    toolCount: toolCount || prev.toolCount,
    tokens: tokens || prev.tokens,
    durationMs: durationMs || prev.durationMs,
    currentTool,
    children: children.length > 0 ? children : prev.children,
  }
}
