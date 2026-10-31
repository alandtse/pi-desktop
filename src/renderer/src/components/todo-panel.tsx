import { useContext, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, CircleDot, Circle, Check, X } from 'lucide-react'
import { NowContext } from '../utils/relative-time'
import { formatRelativeTime } from '../utils/format-relative-time'
import type { TodoPlacement } from '../utils/todo-placement'
import {
  ACTIVE_STATUS,
  activeTask,
  todoCounts,
  visibleTasks,
  type TodoSnapshot,
  type TodoTask,
} from '../todo-state'

/**
 * The task list the running chat is working from.
 *
 * A todo list is not part of the transcript — it lives in the session's branch, so
 * the messages the app already renders never mention it. It sat invisible in the GUI
 * even though `rpiv-todo` writes a full snapshot on every change and pi streams each
 * one as `entry_appended`. This panel is the read-out.
 *
 * Placed above the transcript and collapsed to one line by default: it is context for
 * reading the conversation, not a thing to interact with, and the agent is the one
 * that owns the list.
 */
export function TodoPanel({
  snapshot,
  placement,
  onHide,
}: {
  snapshot: TodoSnapshot | null
  /** Where the caller has room to draw it; the inline fallback is the old layout. */
  placement: TodoPlacement
  /** Offered in the header so the panel can be dismissed without a settings trip. */
  onHide?: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const tasks = visibleTasks(snapshot)
  const now = useContext(NowContext)
  // The gutter is narrow, so it starts collapsed there: a full list beside the
  // transcript is a second column of text competing with the answer. Above the
  // transcript there is vertical room and the old default still reads better.
  const [open, setOpen] = useState(placement.mode !== 'gutter')
  const inGutter = placement.mode === 'gutter'

  // A chat with no task list gets no panel. One with tasks all done still does — the
  // finished state is what tells the user the work is finished.
  if (tasks.length === 0) return null

  const counts = todoCounts(tasks)
  const active = activeTask(tasks)
  // Dates the whole list by its last recorded change. A snapshot with no time shows
  // nothing rather than a time the panel guessed.
  const updatedLabel = snapshot?.updatedAt ? formatRelativeTime(snapshot.updatedAt, now) : null

  return (
    <div
      className={
        inGutter
          ? 'shrink-0 pt-3 pl-3'
          : 'mx-auto w-full max-w-3xl px-4 pt-3'
      }
      style={inGutter ? { width: placement.width } : undefined}
    >
      <div className="relative overflow-hidden rounded-lg border border-border bg-surface">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-dim hover:text-primary"
          aria-expanded={open}
          title={t('chat.todo.toggle')}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="font-medium text-primary">{t('chat.todo.title')}</span>
          {/* When everything is done the count alone would read "3 tasks" with no sign
              that none are left, so the done state is named. */}
          <span className="text-faint">
            {counts.remaining === 0
              ? t('chat.todo.allDone', { n: counts.total })
              : t('chat.todo.remaining', { n: counts.remaining, total: counts.total })}
          </span>
          {/* The working task is worth naming even collapsed: it is the one line that
              answers "what is it doing right now?" without opening anything. */}
          {!open && active && (
            <span className="ml-1 truncate text-xs text-accent">{active.activeForm || active.subject}</span>
          )}
          {/* When the list last changed. Every branch entry carries a timestamp, so
              this is the moment the agent recorded the state, not when the panel
              happened to render. Kept out of the gutter, where the header already
              has to fit a title, a count and a task name in ~200px. */}
          {!inGutter && updatedLabel && (
            <span className="ml-auto shrink-0 pl-2 text-faint">{updatedLabel}</span>
          )}
        </button>
        {onHide && (
          <button
            type="button"
            onClick={onHide}
            className="absolute right-1 top-1 rounded p-1 text-faint hover:bg-highlight hover:text-primary"
            title={t('chat.todo.hide')}
            aria-label={t('chat.todo.hide')}
          >
            <X size={12} />
          </button>
        )}
        {open && (
          <ul className="border-t border-border px-3 py-1.5">
            {tasks.map((task) => (
              <TodoRow key={task.id} task={task} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function TodoRow({ task }: { task: TodoTask }): React.JSX.Element {
  const done = task.status === 'completed'
  const running = task.status === ACTIVE_STATUS
  return (
    <li className="flex items-start gap-2 py-0.5 text-xs">
      <span className="mt-0.5 shrink-0">
        {done ? (
          <Check size={12} className="text-success" aria-hidden="true" />
        ) : running ? (
          // A live task is the only thing in the panel that moves. Lucide's dot is
          // enough motion to catch the eye without pulling focus from the answer.
          <CircleDot size={12} className="animate-pulse text-accent" aria-hidden="true" />
        ) : (
          <Circle size={12} className="text-faint" aria-hidden="true" />
        )}
      </span>
      <span
        className={
          done
            ? 'text-faint line-through'
            : running
              ? 'font-medium text-primary'
              : 'text-dim'
        }
      >
        {/* A task being worked on reads better in the present tense the agent wrote. */}
        {running && task.activeForm ? task.activeForm : task.subject}
      </span>
    </li>
  )
}
