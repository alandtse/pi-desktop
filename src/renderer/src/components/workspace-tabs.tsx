import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Boxes, CheckCircle2, FolderOpen, GitBranch, Laptop, Loader2, MessageSquarePlus, PanelLeft, Plus, Settings, X, XCircle } from 'lucide-react'
import { clsx } from 'clsx'
import { useAppStore } from '../store'
import { useGlobalWorkflowOpen } from '../hooks'
import { projectTabs as getProjectTabs } from '../utils/tab-navigation'
import { isTabActive, remoteProjectTabs, sessionTabs as getSessionTabs } from '../utils/session-tabs'
import { activeShortcuts } from '../utils/app-shortcuts'
import { formatShortcut } from '../../../shared/keyboard-shortcuts'
import { SessionRuntimeIndicator } from './session-runtime-indicator'
import type { RelayStatus, Workspace } from '../../../shared/ipc-contracts'

const PROJECT_TAB_DRAG_TYPE = 'application/x-pi-desktop-project-tab'

function tabLabel(workspace: Workspace): string {
  return workspace.name || workspace.path.split(/[\\/]/).filter(Boolean).pop() || workspace.path
}

export function WorkspaceTabs(): React.JSX.Element {
  const { t } = useTranslation()
  const workspaces = useAppStore((state) => state.workspaces)
  const projectTabOrder = useAppStore((state) => state.projectTabOrder)
  const reorderProjectTab = useAppStore((state) => state.reorderProjectTab)
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; placement: 'before' | 'after' } | null>(null)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const sessionList = useAppStore((state) => state.sessionList)
  const sessionRuntimes = useAppStore((state) => state.sessionRuntimes)
  const activeSessionRuntimeId = useAppStore((state) => state.activeSessionRuntimeId)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)
  const workspaceActivity = useAppStore((state) => state.workspaceActivity)
  const currentView = useAppStore((state) => state.currentView)
  const globalWorkflowOpen = useGlobalWorkflowOpen()
  const setWorkflowPanelOpen = useAppStore((state) => state.setWorkflowPanelOpen)
  const activateWorkspace = useAppStore((state) => state.activateWorkspace)
  const switchSession = useAppStore((state) => state.switchSession)
  const closeSessionTab = useAppStore((state) => state.closeSessionTab)
  const openRemoteSession = useAppStore((state) => state.openRemoteSession)
  const activeRemoteRef = useAppStore((state) => state.activeRemoteRef)
  const removeWorkspace = useAppStore((state) => state.removeWorkspace)
  const createWorktreeTab = useAppStore((state) => state.createWorktreeTab)
  const setLinkedTaskDialog = useAppStore((state) => state.setLinkedTaskDialog)
  const createNewSession = useAppStore((state) => state.createNewSession)
  const newSessionShortcut = useAppStore((state) => activeShortcuts(state).newSession)
  const setCurrentView = useAppStore((state) => state.setCurrentView)
  /**
   * Leaves a remote project for the local chat that is already open.
   *
   * A remote project tab and a local one are peers in this row, so choosing the
   * local one has to let go of the remote binding — otherwise two projects would
   * read as active and the composer would keep talking to the other machine.
   */
  const getBackToLocalChat = (): void => {
    const path = sessionState?.sessionFile
    if (path) void switchSession(path, activeWorkspace?.path)
    else useAppStore.setState({ activeRemoteRef: null })
  }
  const sessionState = useAppStore((state) => state.sessionState)

  const toolView = ['settings', 'packages', 'notes', 'skills', 'diagnostics'] as const
  const toolsActive =
    toolView.includes(currentView as (typeof toolView)[number]) || globalWorkflowOpen

  const tabs = useMemo(
    () => getProjectTabs(workspaces, projectTabOrder),
    [workspaces, projectTabOrder]
  )
  // Names live on the relay status, so this strip follows it rather than
  // subscribing to a second copy that could drift.
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null)
  useEffect(() => {
    let live = true
    void window.piDesktop.relay.status().then((status) => { if (live) setRelayStatus(status) }).catch(() => undefined)
    const stop = window.piDesktop.relay.onStatus(setRelayStatus)
    return () => {
      live = false
      stop()
    }
  }, [])
  // A session on another machine belongs to a folder THERE, so it is a project
  // tab of its own rather than a chat inside whichever local project is active.
  const remoteProjects = useMemo(
    () => remoteProjectTabs(sessionList, relayStatus?.settings.machineNames ?? {}),
    [sessionList, relayStatus?.settings.machineNames],
  )
  const activeRemoteProjectId = useMemo(() => {
    if (!activeRemoteRef) return null
    return remoteProjects.find((project) => project.rows.some((row) =>
      row.ref.peer === activeRemoteRef.peer && row.ref.roomId === activeRemoteRef.roomId))?.id ?? null
  }, [activeRemoteRef, remoteProjects])

  // The strip under the project row is the chats in the project on screen.
  // When that "project" is another machine, its sessions are those chats, so a
  // remote session switches exactly the way a local one does.
  const activeRemoteProject = remoteProjects.find((project) => project.id === activeRemoteProjectId)
  const sessionTabs = useMemo(
    () => getSessionTabs({
      runtimes: sessionRuntimes,
      // The strip shows the chats of the project on screen. When that project
      // is another machine, the local project's chats are not on screen, so
      // they must not appear beside the remote ones as an extra tab.
      workspaceId: activeRemoteProject ? undefined : activeWorkspace?.id,
      // Local chats are named from their rows; the relay's rows are passed
      // separately so they cannot leak into the local list.
      sessionList,
      remoteRows: activeRemoteProject?.rows ?? [],
      newSessionFallback: t('workspaceTabs.newSessionFallback'),
    }),
    // `sessionList` lands after the first paint, so it must be a dependency or
    // the tabs keep the names they had before it arrived — every local chat
    // stayed "New Session" until something else forced a recalculation.
    [activeWorkspace?.id, sessionRuntimes, activeRemoteProject, sessionList, t]
  )

  return (
    <div className="flex shrink-0 flex-col bg-app">
    <div className="flex h-10 items-end gap-1 overflow-x-auto border-b border-border px-2 pt-1">
      {!sidebarOpen && (
        <button
          type="button"
          onClick={toggleSidebar}
          className="mb-1 flex h-7 w-7 shrink-0 animate-fade-in items-center justify-center rounded-md border border-border-strong bg-surface text-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus"
          title={t('common.showSidebar')}
          aria-label={t('common.showSidebar')}
        >
          <PanelLeft size={15} />
        </button>
      )}
      {tabs.map((workspace) => {
        const active = workspace.id === activeWorkspace?.id && !toolsActive
        const activity = workspaceActivity[workspace.id]
        const isWorktree = workspace.kind === 'worktree'
        const isLinkedTask = workspace.kind === 'repoSet'
        // Worktree and linked task tabs close; a folder workspace is removed.
        const isTab = isWorktree || isLinkedTask
        const isWorking = activity?.state === 'working'
        const needsApproval = activity?.state === 'needs-approval'
        const completed = activity?.state === 'completed'
        const failed = activity?.state === 'failed'

        return (
          <div
            key={workspace.id}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(PROJECT_TAB_DRAG_TYPE, workspace.id)
              event.dataTransfer.effectAllowed = 'move'
              setDraggedProjectId(workspace.id)
            }}
            onDragEnd={() => {
              setDraggedProjectId(null)
              setDropTarget(null)
            }}
            onDragOver={(event) => {
              if (!draggedProjectId || !event.dataTransfer.types.includes(PROJECT_TAB_DRAG_TYPE)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              const bounds = event.currentTarget.getBoundingClientRect()
              setDropTarget({ id: workspace.id, placement: event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after' })
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
            }}
            onDrop={(event) => {
              if (!draggedProjectId || event.dataTransfer.getData(PROJECT_TAB_DRAG_TYPE) !== draggedProjectId) return
              event.preventDefault()
              event.stopPropagation()
              const bounds = event.currentTarget.getBoundingClientRect()
              reorderProjectTab(draggedProjectId, workspace.id, event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after')
              setDraggedProjectId(null)
              setDropTarget(null)
            }}
            onAuxClick={(event) => {
              // DOM button 1 is the middle mouse button. Keep right-click for
              // the normal context menu and use the middle button as tab-close.
              if (event.button !== 1) return
              event.preventDefault()
              void removeWorkspace(workspace.id)
            }}
            className={clsx(
              'group relative flex h-9 min-w-[150px] max-w-[240px] shrink-0 select-none items-center gap-2 rounded-t-md border border-b-0 px-2.5 text-xs transition-colors',
              draggedProjectId === workspace.id && 'opacity-50',
              active
                ? 'border-border bg-surface text-primary'
                : 'border-transparent text-muted hover:bg-surface/60 hover:text-secondary'
            )}
          >
            {dropTarget?.id === workspace.id && draggedProjectId !== workspace.id && (
              <span aria-hidden="true" className={clsx(
                'pointer-events-none absolute inset-y-0 w-0.5 rounded bg-accent-fg',
                dropTarget.placement === 'before' ? 'left-0' : 'right-0'
              )} />
            )}
            <button
              type="button"
              onClick={() => {
                setWorkflowPanelOpen(false)
                // A remote project is a tab in this row too, so choosing a local
                // one has to leave it: only one project is on screen.
                if (activeRemoteRef) getBackToLocalChat()
                if (workspace.id === activeWorkspace?.id) {
                  setCurrentView('chat')
                  return
                }
                void activateWorkspace(workspace.id).then((switched) => {
                  if (switched) setCurrentView('chat')
                })
              }}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              title={`${workspace.path}${workspace.branch ? `\n${workspace.branch}` : ''}`}
            >
              {isLinkedTask ? (
                <Boxes size={13} className="shrink-0 text-special" />
              ) : isWorktree ? (
                <GitBranch size={13} className="shrink-0 text-special" />
              ) : (
                <FolderOpen size={13} className="shrink-0 text-dim" />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">{tabLabel(workspace)}</span>
              {isWorking && <Loader2 size={12} className="shrink-0 animate-spin text-accent-fg" />}
              {needsApproval && <AlertCircle size={12} className="shrink-0 text-warning" />}
              {completed && <CheckCircle2 size={12} className="shrink-0 text-success" />}
              {failed && <XCircle size={12} className="shrink-0 text-error" />}
            </button>
            {tabs.length > 1 && (
              <button
                type="button"
                onClick={() => void removeWorkspace(workspace.id)}
                draggable
                onDragStart={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                className="shrink-0 rounded p-0.5 text-faint opacity-0 transition-all hover:bg-highlight hover:text-primary group-hover:opacity-100"
                title={isTab ? t('store.confirm.closeTabLabel') : t('store.confirm.removeWorkspaceTitle')}
                aria-label={
                  isTab
                    ? t('workspaceTabs.closeTabAriaLabel', { name: tabLabel(workspace) })
                    : t('workspaceTabs.removeWorkspaceAriaLabel', { name: tabLabel(workspace) })
                }
              >
                <X size={12} />
              </button>
            )}
          </div>
        )
      })}

      {remoteProjects.map((project) => {
        const active = project.id === activeRemoteProjectId
        // Opening a remote project shows the chat that is already driving it, or
        // the first session it advertises: the tab is the folder, and a folder
        // with no chat on screen would be a tab that goes nowhere.
        const openProject = (): void => {
          setWorkflowPanelOpen(false)
          const driving = activeRemoteRef
            ? project.rows.find((row) => row.ref.peer === activeRemoteRef.peer && row.ref.roomId === activeRemoteRef.roomId)
            : undefined
          const target = driving ?? project.rows[0]
          if (target) void openRemoteSession(target.ref)
        }
        const working = project.rows.some((row) => row.session.contentState === 'non-empty')
        return (
          <div
            key={project.id}
            className={clsx(
              'group relative flex h-9 min-w-[150px] max-w-[240px] shrink-0 select-none items-center gap-2 rounded-t-md border border-b-0 px-2.5 text-xs transition-colors',
              active
                ? 'border-border bg-surface text-primary'
                : 'border-transparent text-muted hover:bg-surface/60 hover:text-secondary'
            )}
          >
            <button
              type="button"
              onClick={openProject}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              // The tab names the machine; hovering names where its sessions run,
              // which is the part a tab has no room to show.
              title={project.paths.length > 0 ? project.paths.join('\n') : project.title}
            >
              <Laptop size={13} className="shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate font-medium">{project.title}</span>
              <span className="shrink-0 text-[10px] text-faint">
                {t('workspaceTabs.remoteSessionCount', { count: project.rows.length })}
              </span>
              {working && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-fg" />}
            </button>
          </div>
        )
      })}

      {toolsActive && (
        <div className="group flex h-9 min-w-[140px] shrink-0 items-center rounded-t-md border border-b-0 border-border bg-surface text-primary">
          {/* The tab only exists while a tool surface is on screen, so its label
              always names what is already showing — a static marker, never a
              control that navigates somewhere the user did not ask for. Closing
              is the neighbouring button's job. */}
          <div
            aria-current="page"
            className="flex min-w-0 flex-1 items-center gap-2 px-2.5 text-left text-xs"
            title={t('workspaceTabs.tools')}
          >
            <Settings size={13} className="shrink-0 text-accent-fg" />
            <span className="truncate font-medium">{t('workspaceTabs.tools')}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setWorkflowPanelOpen(false)
              setCurrentView('chat')
            }}
            className="mr-1 rounded p-1 text-faint opacity-0 transition-all hover:bg-highlight hover:text-primary group-hover:opacity-100"
            title={t('workspaceTabs.closeTools')}
            aria-label={t('workspaceTabs.closeTools')}
          >
            <X size={12} />
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          setWorkflowPanelOpen(false)
          setCurrentView('chat')
          void createNewSession()
        }}
        className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-primary transition-colors"
        title={newSessionShortcut
          ? t('settings.shortcuts.actionWithShortcut', { action: t('workspaceTabs.newSessionAriaLabel'), shortcut: formatShortcut(newSessionShortcut, window.piDesktop.system.platform) })
          : t('workspaceTabs.newSessionAriaLabel')}
        aria-label={t('workspaceTabs.newSessionAriaLabel')}
      >
        <MessageSquarePlus size={15} />
      </button>
      <button
        type="button"
        onClick={() => void createWorktreeTab()}
        className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-primary transition-colors"
        title={t('workspaceTabs.newIsolatedTabTitle')}
        aria-label={t('workspaceTabs.newIsolatedTabAriaLabel')}
      >
        <Plus size={15} />
      </button>
      <button
        type="button"
        onClick={() => setLinkedTaskDialog({ view: 'start' })}
        className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-primary transition-colors"
        title={t('workspaceTabs.newLinkedTaskTitle')}
        aria-label={t('workspaceTabs.newLinkedTaskAriaLabel')}
      >
        <Boxes size={15} />
      </button>
    </div>
    {sessionTabs.length > 0 && (
      <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/70 px-2">
        <span className="mr-1 shrink-0 text-[10px] uppercase tracking-wide text-faint">{t('workspaceTabs.sessions')}</span>
        {sessionTabs.map((tab) => {
          const active = isTabActive(tab, activeSessionRuntimeId, activeRemoteRef)
          return (
            <div
              key={tab.id}
              onAuxClick={(event) => {
                if (event.button !== 1) return
                // Only a local tab has a runtime to close; a remote session
                // belongs to the other machine and is not ours to end.
                if (tab.kind !== 'local' || !tab.runtime) return
                event.preventDefault()
                void closeSessionTab(tab.runtime.runtimeId)
              }}
              className={clsx(
                'group flex min-w-0 max-w-[240px] shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px] transition-colors',
                active ? 'bg-card text-primary' : 'text-muted hover:bg-highlight hover:text-secondary'
              )}
            >
              <button
                type="button"
                onClick={() => {
                  setCurrentView('chat')
                  if (tab.kind === 'remote') { void openRemoteSession(tab.ref!); return }
                  if (!tab.runtime?.sessionPath) return
                  void switchSession(tab.runtime.sessionPath, activeWorkspace?.path)
                }}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5 text-left"
                // A remote chat's hover names the folder it runs in on the other
                // machine: the label is the session, which does not say where it
                // lives, and the room id on its own says nothing at all.
                title={tab.kind === 'remote' ? tab.tooltip : tab.runtime?.sessionPath ?? undefined}
                aria-current={active ? 'page' : undefined}
              >
                {tab.kind === 'remote' ? <Laptop size={11} className="shrink-0 text-faint" /> : tab.runtime ? <SessionRuntimeIndicator runtime={tab.runtime} /> : null}
                <span className="truncate">{tab.title}</span>
              </button>
              {tab.kind === 'local' && tab.runtime && (
                <button
                  type="button"
                  onClick={() => void closeSessionTab(tab.runtime!.runtimeId)}
                  className="shrink-0 rounded p-0.5 text-faint opacity-0 transition-all hover:bg-highlight-strong hover:text-primary group-hover:opacity-100"
                  title={t('workspaceTabs.closeSessionTab')}
                  aria-label={t('workspaceTabs.closeSessionTab')}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    )}
    </div>
  )
}
