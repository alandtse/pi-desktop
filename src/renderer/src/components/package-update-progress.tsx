import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Ban, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import type { PackageUpdateProgress } from '../../../shared/ipc-contracts'
import type { Translate } from '../../../shared/i18n'
import { useAppStore } from '../store'
import { formatSubagentDuration } from './subagent-task-row'

const TICK_MS = 1_000

/**
 * What "Update all" is doing right now.
 *
 * It used to show nothing at all: main ran npm/pi without forwarding a line and
 * replaced the Installed tab with a bare spinner. This panel names the phase,
 * streams the CLI's own output, shows elapsed time, and offers Cancel.
 */
export function PackageUpdateProgressPanel(): React.JSX.Element | null {
  const { t } = useTranslation()
  const progress = useAppStore((state) => state.packageUpdateProgress)
  const startedAt = useAppStore((state) => state.packageUpdateStartedAt)
  const lines = useAppStore((state) => state.packageUpdateLines)
  const busy = useAppStore((state) => state.packageLoading)
  const cancel = useAppStore((state) => state.cancelPackageUpdate)
  const [showLog, setShowLog] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const running = progress !== null && busy && progress.phase !== 'done' && progress.phase !== 'cancelled'

  useEffect(() => {
    if (!running || startedAt === null) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [running, startedAt])

  // A finished run is reported by the result notification instead.
  if (!progress || !running) return null

  const elapsed = startedAt !== null
    ? formatSubagentDuration(Math.floor((now - startedAt) / TICK_MS) * TICK_MS)
    : null

  const label = phaseLabel(progress, t)
  const total = progress.total ?? 0
  const completed = progress.completed ?? 0
  const hasTotal = total > 0
  const fraction = hasTotal ? Math.min(1, Math.max(0, completed / total)) : 0

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-lg border border-border-strong bg-card/60 px-4 py-3"
    >
      <div className="flex items-start gap-2">
        <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-sm text-primary">{label}</span>
            {hasTotal && (
              <span className="text-[11px] text-dim">
                {t('packages.progress.step', { completed, total })}
              </span>
            )}
          </div>
          {elapsed && (
            <div className="mt-0.5 text-[11px] text-dim">
              {t('packages.progress.elapsed', { duration: elapsed })}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setCancelling(true)
              void cancel().finally(() => setCancelling(false))
            }}
            disabled={cancelling}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-secondary transition-colors hover:bg-highlight-strong hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Ban size={11} />
            {cancelling ? t('packages.progress.cancelling') : t('packages.progress.cancel')}
          </button>
        </div>
      </div>

      {/* Determinate when the run knows its steps (OMP), pulsing otherwise:
          npm and `pi update` report no reliable step total, and a fake
          percentage would be worse than an honest indeterminate bar. */}
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-hover">
        <div
          className={clsx(
            'h-full rounded-full bg-accent transition-[width] duration-500',
            hasTotal ? '' : 'w-1/3 animate-pulse',
          )}
          style={hasTotal ? { width: `${Math.round(fraction * 100)}%` } : undefined}
        />
      </div>

      <div className="mt-2">
        <button
          type="button"
          onClick={() => setShowLog((open) => !open)}
          className="flex items-center gap-1 text-[11px] text-dim transition-colors hover:text-secondary"
          aria-expanded={showLog}
        >
          {showLog ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {showLog ? t('packages.progress.hideLog') : t('packages.progress.showLog')}
          {!showLog && lines.length > 0 && (
            <span className="ml-1 min-w-0 truncate text-faint">{lines[lines.length - 1]}</span>
          )}
        </button>
        {showLog && (
          <pre className="mt-1.5 max-h-40 overflow-auto rounded border border-border bg-surface/70 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-secondary whitespace-pre-wrap break-words">
            {lines.length > 0 ? lines.join('\n') : t('packages.progress.noOutputYet')}
          </pre>
        )}
      </div>
    </div>
  )
}

/** The phase in words; the runtime wait names the engine whose CLI is blocked. */
function phaseLabel(progress: PackageUpdateProgress, t: Translate): string {
  switch (progress.phase) {
    case 'preparing':
      return t('packages.progress.preparing')
    case 'running':
    case 'output':
      return progress.target === 'all'
        ? t('packages.progress.runningAll')
        : t('packages.progress.running', { target: progress.target })
    case 'done':
      return progress.success === false ? t('packages.progress.failed') : t('packages.progress.done')
    case 'cancelled':
      return t('packages.progress.cancelled')
  }
}
