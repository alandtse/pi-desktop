import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, CircleDot, Circle, Check } from 'lucide-react'
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
export function TodoPanel({ snapshot }: { snapshot: TodoSnapshot | null }): React.JSX.Element | null {
  const { t } = useTranslation()
  const tasks = visibleTasks(snapshot)
  const [open, setOpen] = useState(true)

  // A chat with no task list gets no panel. One with tasks all done still does — the
  // finished state is what tells the user the work is finished.
  if (tasks.length === 0) return null

  const counts = todoCounts(tasks)
  const active = activeTask(tasks)

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-3">
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
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
              ? t('chat.todo.allDone', { count: counts.total })
              : t('chat.todo.remaining', { count: counts.remaining, total: counts.total })}
          </span>
          {/* The working task is worth naming even collapsed: it is the one line that
              answers "what is it doing right now?" without opening anything. */}
          {!open && active && (
            <span className="ml-1 truncate text-xs text-accent">{active.activeForm || active.subject}</span>
          )}
        </button>
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
