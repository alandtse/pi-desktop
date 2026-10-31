import type { AgentEngine, AppSettings, PairedRelayAgent, RelaySettings } from './ipc-contracts'
import { DEFAULT_SETTINGS } from './default-settings'
import { normalizeLanguageSetting } from './i18n/resolve'
import { normalizeRelayUrl } from './relay-protocol'
import { isPermissionMode } from './permission-mode'
import { getVoiceModel, type VoicePrecision } from './voice-models'
import { isVoiceDevice } from './voice-device'
import { isChatWidth } from './chat-width'
import { isTodoPlacementMode } from './todo-placement'
import { normalizeKeyboardShortcuts } from './keyboard-shortcuts'
import { normalizeSkillGroups } from './skill-groups'

const ENGINE_SETTINGS: readonly AgentEngine[] = ['auto', 'pi', 'omp']
const VOICE_PRECISIONS: readonly VoicePrecision[] = ['int8', 'fp16']

function isEngineSetting(value: unknown): value is AgentEngine {
  return typeof value === 'string' && (ENGINE_SETTINGS as readonly string[]).includes(value)
}

function isVoicePrecision(value: unknown): value is VoicePrecision {
  return typeof value === 'string' && (VOICE_PRECISIONS as readonly string[]).includes(value)
}

/**
 * Merge a settings file over the defaults and replace every enumerated value
 * the file may hold in a form no build writes (hand edits, other versions), so
 * the renderer never indexes a lookup with an unknown key.
 */
export function normalizeStoredSettings(stored: Record<string, unknown>, languages: readonly string[]): AppSettings {
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...stored }
  if (!isEngineSetting(merged.piEngine)) merged.piEngine = DEFAULT_SETTINGS.piEngine
  if (!isPermissionMode(merged.permissionMode)) merged.permissionMode = DEFAULT_SETTINGS.permissionMode
  if (!isChatWidth(merged.chatWidth)) merged.chatWidth = DEFAULT_SETTINGS.chatWidth
  if (!isTodoPlacementMode(merged.todoPlacement)) merged.todoPlacement = DEFAULT_SETTINGS.todoPlacement
  merged.uiFontFamily = typeof merged.uiFontFamily === 'string'
    ? merged.uiFontFamily.trim()
    : DEFAULT_SETTINGS.uiFontFamily
  if (typeof merged.defaultThinkingLevel !== 'string' || !merged.defaultThinkingLevel.trim()) {
    merged.defaultThinkingLevel = DEFAULT_SETTINGS.defaultThinkingLevel
  }
  merged.language = normalizeLanguageSetting(merged.language, languages)
  merged.shortcuts = normalizeKeyboardShortcuts(merged.shortcuts)
  merged.skillGroups = normalizeSkillGroups(merged.skillGroups)
  if (typeof merged.voiceModel !== 'string' || !getVoiceModel(merged.voiceModel)) {
    merged.voiceModel = DEFAULT_SETTINGS.voiceModel
  }
  if (!isVoicePrecision(merged.voicePrecision)) merged.voicePrecision = DEFAULT_SETTINGS.voicePrecision
  if (!isVoiceDevice(merged.voiceDevice)) merged.voiceDevice = DEFAULT_SETTINGS.voiceDevice
  merged.relay = normalizeRelaySettings(merged.relay)
  return merged
}

const RELAY_PUBKEY_BYTES = 32

/**
 * Keeps a hand-edited `relay` block usable without trusting it.
 *
 * A relay url that the client cannot dial is dropped to null rather than kept,
 * because a stored-but-invalid url would retry forever against a dead endpoint.
 */
function normalizeRelaySettings(value: unknown): RelaySettings {
  if (!value || typeof value !== 'object') return DEFAULT_SETTINGS.relay
  const candidate = value as Partial<RelaySettings>
  const url = typeof candidate.url === 'string' && normalizeRelayUrl(candidate.url) ? candidate.url : null
  return {
    // Without a usable url nothing can be dialled, so enabled cannot outlive it.
    enabled: url !== null && candidate.enabled === true,
    url,
    pairedAgent: normalizePairedAgent(candidate.pairedAgent),
    // MIGRATION: a settings file written before several machines were supported
    // stores one `pairedAgent` and no list. Seeding the list from it keeps the
    // existing pairing working without the user re-pairing.
    pairedAgents: normalizePairedAgents(candidate.pairedAgents, candidate.pairedAgent),
    machineNames: normalizeMachineNames(candidate.machineNames),
  }
}

/**
 * Every machine this desktop is paired with.
 *
 * A malformed entry is dropped rather than repaired: a pairing carries a key, and
 * guessing at a half-trusted one would address frames to the wrong machine. A
 * duplicate is collapsed so two entries cannot name the same machine and produce
 * two tabs for it.
 */
function normalizePairedAgents(list: unknown, legacy: unknown): PairedRelayAgent[] {
  const fallback = normalizePairedAgent(legacy)
  if (!Array.isArray(list)) return fallback ? [fallback] : []
  const seen = new Set<string>()
  const agents: PairedRelayAgent[] = []
  for (const entry of list) {
    const agent = normalizePairedAgent(entry)
    if (!agent || seen.has(agent.pubkey)) continue
    seen.add(agent.pubkey)
    agents.push(agent)
  }
  // A list that lost every entry still describes the legacy pairing, so fall back
  // rather than silently forgetting a machine the user is relying on.
  if (agents.length === 0 && fallback) return [fallback]
  return agents
}

/**
 * Names the user gave machines, keyed by peer key.
 *
 * Anything malformed is dropped rather than repaired: a name is cosmetic, and a
 * half-trusted key would attach the wrong name to the wrong computer.
 */
function normalizeMachineNames(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const names: Record<string, string> = {}
  for (const [key, name] of Object.entries(value as Record<string, unknown>)) {
    if (typeof name !== 'string') continue
    const trimmed = name.trim()
    // An empty name would shadow the reported hostname and show a blank label.
    if (key === '' || trimmed === '') continue
    names[key] = trimmed
  }
  return names
}

function normalizePairedAgent(value: unknown): PairedRelayAgent | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<PairedRelayAgent>
  if (typeof candidate.pubkey !== 'string' || typeof candidate.pairedAt !== 'string') return null
  if (Buffer.from(candidate.pubkey, 'base64').length !== RELAY_PUBKEY_BYTES) return null
  return {
    pubkey: candidate.pubkey,
    agentName: typeof candidate.agentName === 'string' ? candidate.agentName : '',
    // Preserved across restarts: the relay addresses by (peer, room), so losing
    // this would leave every frame unroutable until the next pairing.
    roomId: typeof candidate.roomId === 'string' && candidate.roomId.length > 0 ? candidate.roomId : null,
    pairedAt: candidate.pairedAt,
  }
}
