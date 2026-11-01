import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { getGuiDataPath } from './app-data-paths'
import { pathGroupKey } from '../shared/path-compare'

/**
 * Which session was last on screen in each project.
 *
 * "Resume last session" used to mean "the newest session file". That is a
 * different question: a user who reads an older conversation and switches away
 * comes back to whichever file the engine wrote most recently — often the one
 * belonging to another chat entirely, or a session another tool touched. The
 * project tab then landed somewhere the user never chose.
 *
 * This records the actual choice. It is a GUI annotation like the archive
 * registry, not engine state: Pi has no notion of "the session this window was
 * showing", so nothing on the Pi side could answer it.
 *
 * Shape on disk: { "<projectPath>": { "sessionPath": "...", "at": <epochMs> } }
 * Keyed by the case-folded project path so Windows paths match themselves.
 */

const MEMORY_FILE_NAME = 'project-sessions.json'

interface ProjectSessionEntry {
  sessionPath: string
  at: number
}

type MemoryStore = Record<string, ProjectSessionEntry>

export class ProjectSessionMemory {
  private readonly path: string
  private cache: MemoryStore = {}
  private loaded = false

  constructor() {
    this.path = getGuiDataPath(MEMORY_FILE_NAME)
  }

  /**
   * The session last shown in `projectPath`, or null when none is recorded.
   *
   * The recorded path is returned even if the file has since been deleted:
   * callers verify existence, and dropping it here would silently fall back to
   * "newest file", which is the behaviour this replaces.
   */
  async get(projectPath: string): Promise<string | null> {
    await this.ensureLoaded()
    return this.cache[this.key(projectPath)]?.sessionPath ?? null
  }

  /** Records `sessionPath` as the chat a project was last showing. */
  async remember(projectPath: string, sessionPath: string): Promise<void> {
    if (!projectPath || !sessionPath) return
    await this.ensureLoaded()
    const key = this.key(projectPath)
    const existing = this.cache[key]
    if (existing?.sessionPath === sessionPath) return
    this.cache[key] = { sessionPath, at: Date.now() }
    await this.save()
  }

  /** Drops a project's record, e.g. when its workspace is removed. */
  async forget(projectPath: string): Promise<void> {
    await this.ensureLoaded()
    const key = this.key(projectPath)
    if (!(key in this.cache)) return
    delete this.cache[key]
    await this.save()
  }

  async getAll(): Promise<MemoryStore> {
    await this.ensureLoaded()
    return { ...this.cache }
  }

  private key(projectPath: string): string {
    return pathGroupKey(projectPath)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    try {
      if (existsSync(this.path)) {
        const data = await readFile(this.path, 'utf-8')
        const parsed = JSON.parse(data) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.cache = parsed as MemoryStore
        }
      }
    } catch {
      this.cache = {}
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    try {
      const dir = join(this.path, '..')
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true })
      }
      await writeFile(this.path, JSON.stringify(this.cache, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to save project session memory:', err)
    }
  }
}
