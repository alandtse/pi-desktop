import {
  Globe,
  FileText,
  FilePlus,
  FilePen,
  Terminal,
  Search,
  FolderTree,
  type LucideIcon,
} from 'lucide-react'
import { toolKind, type ToolKind } from '../../../shared/chat/message-grouping'

// Icon that mirrors a tool call's operation (a fetch shows a globe, a read a
// document, etc.). Keyed off the same tool kind as toolCallLabel so icon and
// text stay in sync. Unknown tools fall back to the Terminal icon (same as
// run) — a custom tool is most often a command-style call, so the terminal
// reads sensibly as a generic op. Shared by the finalized message bubble (as
// a row avatar) and the streaming bubble (inline in the tool box).
const TOOL_CALL_ICONS: Record<ToolKind, LucideIcon> = {
  fetch: Globe,
  read: FileText,
  write: FilePlus,
  edit: FilePen,
  run: Terminal,
  search: Search,
  list: FolderTree,
}

export function toolCallIconFor(name: string): LucideIcon {
  const kind = toolKind(name)
  return kind ? TOOL_CALL_ICONS[kind] : Terminal
}
