import { useState } from 'react'
import { ArrowUpRight, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PendingPromptItem } from '../../../shared/ipc-contracts'
import type { PendingPromptAnswer } from '../utils/pending-prompt'

interface PendingPromptCardProps {
  item: PendingPromptItem
  workspaceName: string
  sessionTitle: string
  alreadyOpen: boolean
  busy: boolean
  onOpenSession: () => void
  onAnswer: (answer: PendingPromptAnswer) => void
}

export function PendingPromptCard({
  item,
  workspaceName,
  sessionTitle,
  alreadyOpen,
  busy,
  onOpenSession,
  onAnswer,
}: PendingPromptCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(item.request.prefill ?? '')
  const request = item.request
  const title = request.title || request.message || t('missionControl.promptControls.untitled')

  return (
    <article className="rounded-lg border border-warning/30 bg-surface/50 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-primary">{title}</div>
          <div className="mt-1 truncate text-[11px] text-faint">{workspaceName} · {sessionTitle}</div>
          {request.title && request.message && (
            <div className="mt-2 max-h-20 overflow-y-auto whitespace-pre-wrap text-xs text-muted">
              {request.message}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onOpenSession}
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] text-muted transition-colors hover:bg-highlight hover:text-primary"
        >
          {t('missionControl.openPromptSession')} <ArrowUpRight size={11} />
        </button>
      </div>

      {alreadyOpen ? (
        <p className="mt-3 rounded bg-highlight/60 px-2 py-1.5 text-[11px] text-muted">
          {t('missionControl.promptAlreadyOpen')}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {request.method === 'confirm' && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onAnswer({ confirmed: true })}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : t('missionControl.promptControls.confirm')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onAnswer({ confirmed: false })}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover disabled:opacity-50"
              >
                {t('missionControl.promptControls.cancel')}
              </button>
            </>
          )}

          {request.method === 'select' && request.options?.map((option, index) => (
            <button
              key={`${index}:${option}`}
              type="button"
              disabled={busy}
              onClick={() => onAnswer({ value: option })}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-primary transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              {option}
            </button>
          ))}

          {request.method === 'input' && (
            <form
              className="flex w-full gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                onAnswer({ value })
              }}
            >
              <input
                autoComplete="off"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={request.placeholder || t('missionControl.promptControls.inputPlaceholder')}
                disabled={busy}
                className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-primary outline-none focus:border-accent disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {t('missionControl.promptControls.send')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onAnswer({ value: '' })}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover disabled:opacity-50"
              >
                {t('missionControl.promptControls.cancel')}
              </button>
            </form>
          )}

          {request.method === 'editor' && (
            <form
              className="flex w-full flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                onAnswer({ value })
              }}
            >
              <textarea
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={request.placeholder || t('missionControl.promptControls.editorPlaceholder')}
                disabled={busy}
                rows={4}
                className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-xs text-primary outline-none focus:border-accent disabled:opacity-50"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onAnswer({ value: '' })}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover disabled:opacity-50"
                >
                  {t('missionControl.promptControls.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {t('missionControl.promptControls.send')}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </article>
  )
}
