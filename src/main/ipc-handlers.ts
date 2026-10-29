import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { createExtensionUiRouter, wireExtensionUiIpc } from './extension-ui-ipc'
import { WorkspaceManager } from './workspace-manager'
import { IPC_CHANNELS } from '../shared/ipc-contracts'
import { createIpcContext } from './ipc/context'
import { assertTrustedSender } from './ipc/validation'
import { registerPiHandlers } from './ipc/pi-handlers'
import { registerTerminalHandlers } from './ipc/terminal-handlers'
import { registerSessionHandlers } from './ipc/session-handlers'
import { registerModelHandlers } from './ipc/model-handlers'
import { registerSettingsHandlers } from './ipc/settings'
import { registerSendQueueHandlers } from './ipc/send-queue'
import { registerPermissionRulesHandlers } from './ipc/permission-rules-handlers'
import { registerThemeHandlers } from './ipc/theme-handlers'
import { registerWorkspaceHandlers } from './ipc/workspace-handlers'
import { registerLinkedTaskHandlers } from './ipc/linked-task-handlers'
import { registerPackageHandlers } from './ipc/package-handlers'
import { registerSkillsMcpHandlers } from './ipc/skills-mcp-handlers'
import { registerModelsConfigHandlers } from './ipc/models-config-handlers'
import { registerCouncilHandlers } from './ipc/council-handlers'
import { registerTagHandlers } from './ipc/tag-handlers'
import { registerNotesHandlers } from './ipc/notes-handlers'
import { registerFileHandlers } from './ipc/file-handlers'
import { registerGitConveyorHandlers } from './ipc/git-conveyor-handlers'
import { registerSystemHandlers } from './ipc/system-handlers'
import { registerUpdateHandlers } from './ipc/update-handlers'
import { registerDiagnosticsHandlers } from './ipc/diagnostics-handlers'
import { registerVoiceHandlers } from './ipc/voice-handlers'
import { registerTypeSafeHandlers } from './ipc/typesafe-handlers'
import { registerWorkflowHandlers } from './ipc/workflow-handlers'
import { registerSubagentHandlers } from './ipc/subagent-handlers'
import { registerRelayHandlers } from './ipc/relay-handlers'
import { registerShutdownTurnsHandler } from './ipc/shutdown-turns-handlers'
import { createTurnTracker } from './turn-tracker'
import { writeShutdownTurnsSync } from './shutdown-turns'
import { getGuiDataDir } from './app-data-paths'
import { appLog } from './app-log'
import { createRelayBridge } from './relay/relay-wiring'
import type { RelaySessionBridge } from './relay/relay-bridge'
import { wireWorkspaceActivity, type WindowControls } from './ipc/workspace-activity-wiring'
import type { WorkspaceTerminals } from './workspace-terminals'
import type { TurnTracker } from './turn-tracker'

export { loadAppSettings, saveAppSettings } from './ipc/settings'

/**
 * Registers all IPC handlers that the renderer can invoke.
 *
 * Security: every handler validates its input types before processing.
 * The preload bridge is the only path from renderer to these handlers.
 * Returns the terminal pool so the app can stop its shells on quit.
 */
export function registerIpcHandlers(
  workspaceManager: WorkspaceManager,
  windowControls: WindowControls = { getWindow: () => null, showWindow: () => {} },
  iconPath = '',
): {
  terminals: WorkspaceTerminals
  relay: RelaySessionBridge
  turnTracker: TurnTracker
  /** This run's identity, so quit-time records can name it. */
  runId: string
} {
  const ctx = createIpcContext(workspaceManager)
  // One identity per app start. Continuation claims name the run that wrote
  // them, so a claim this run is holding is never offered back to it as an
  // interruption — that confusion is what made old chats restart.
  const runId = randomUUID()
  // Fed by the router and read by the quit path; see turn-tracker.ts for why a
  // live record beats inferring an interruption from the session file.
  // Written as the state changes, not only on quit: a forced kill or a crash skips
  // the quit hooks, and those are the cases a continuation recovers from.
  const turnTracker = createTurnTracker(runId, Date.now, {
    onChange: (midTurn) => {
      try {
        // runId and pid travel with every claim: a later run needs to know the
        // claim is not its own before offering to continue it.
        writeShutdownTurnsSync(getGuiDataDir(), {
          runId,
          recordedAt: new Date().toISOString(),
          cleanExit: false,
          midTurn,
        })
      } catch (error) {
        appLog.warn('continue', 'Could not record the mid-turn chats', error)
      }
    },
  })

  // Session runtime snapshots are separate from workspace activity: several
  // live Pi processes may share one project cwd.
  workspaceManager.onSessionRuntime((runtime) => {
    ctx.broadcast(IPC_CHANNELS.EVENT_SESSION_RUNTIME, runtime)
  })

  registerPiHandlers(ctx)
  registerTerminalHandlers(ctx)
  registerSessionHandlers(ctx)
  registerModelHandlers(ctx)
  registerSettingsHandlers(ctx)
  registerSendQueueHandlers()
  registerPermissionRulesHandlers(ctx)
  registerThemeHandlers()
  registerWorkspaceHandlers(ctx)
  registerLinkedTaskHandlers(ctx)
  registerPackageHandlers(ctx)
  registerSkillsMcpHandlers(ctx)
  registerModelsConfigHandlers(ctx)
  registerCouncilHandlers(ctx)
  registerTagHandlers(ctx)
  registerNotesHandlers(ctx)
  registerFileHandlers(ctx)
  registerGitConveyorHandlers(ctx)
  registerSystemHandlers(ctx)
  registerUpdateHandlers()
  registerDiagnosticsHandlers(ctx)
  registerWorkflowHandlers(ctx)
  registerSubagentHandlers(ctx)
  registerVoiceHandlers(ctx)
  registerTypeSafeHandlers()

  // Remote-pi relay. The bridge owns the socket's lifetime, so it is returned
  // to the app: quitting has to close it, and startup has to call `start`.
  const relay = createRelayBridge(workspaceManager)
  registerRelayHandlers(relay)
  relay.onStatusChange((status) => ctx.broadcast(IPC_CHANNELS.EVENT_RELAY_STATUS, status))
  // Live frames are what make a remote session behave like a local one; without
  // this the chat would only ever show the snapshot taken when it was opened.
  relay.onFrame((event) => ctx.broadcast(IPC_CHANNELS.EVENT_RELAY_FRAME, event))

  // ─── Extension UI Responses and Pi Event Forwarding ─────────────────────

  // Cross-workspace activity map + desktop notifications. Wired before the
  // router so it can observe the router's pending-prompt counts below.
  const workspaceActivity = wireWorkspaceActivity(ctx, windowControls, iconPath)

  // Router construction, the dialog-answer channels, the pending-prompt
  // flush/get pair and the two workspace hooks all live in extension-ui-ipc.ts
  // so they can be tested without Electron.
  wireExtensionUiIpc<IpcMainInvokeEvent>({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender,
    router: createExtensionUiRouter({
      workspace: workspaceManager,
      broadcast: ctx.broadcast,
      onPendingCounts: (counts) => workspaceActivity.handlePendingCounts(counts),
      turnTracker,
    }),
    workspace: workspaceManager,
    broadcast: ctx.broadcast,
  })

  // Forward debounced file-change events from the active workspace's watcher
  // so the renderer can refresh the file tree and git status live. The
  // WorkspaceManager only watches the active workspace, so no filtering here.
  workspaceManager.onFileChange((event) => {
    ctx.broadcast(IPC_CHANNELS.EVENT_FILE_CHANGE, event)
  })

  registerShutdownTurnsHandler(workspaceManager, turnTracker, { runId })

  return { terminals: ctx.terminalService, relay, turnTracker, runId }
}
