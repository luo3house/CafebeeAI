/**
 * Global System Prompt registry: reusable assistant prompts shared by every Project (no secrets), stored in
 * `<appRoot>/system-prompts.json` next to providers.json / git-options.json (rule 35). Conversations bind to an
 * entry by id (`Conversation.systemPromptId`); when the id is absent - or points at a deleted custom entry - the
 * send path falls back lazily to the built-in Ask prompt (nothing is rewritten on delete).
 *
 * Built-in entries (added 2026-11-23; the old "Default" pseudo-entry is renamed "Ask"): "Ask" (the fallback text,
 * formerly `DEFAULT_SYSTEM_PROMPT` in llm/chat.ts) and "Code" (a coding-agent preset) are NEVER stored rows.
 * They surface in the picker / CRUD list pinned first with stable ids, are not renameable and not deletable, and
 * tapping either opens the TextEditor READ-ONLY. Custom rows open the editor for editing.
 *
 * Loaded once at bootstrap (`kApp`); the in-memory cache is authoritative afterwards, mutations persist atomically.
 */
import { joinPath, readText, ensureDir, exists, atomicWriteText, appRootPath } from "./fs"
import { uuid32 } from "./uuid"
import { lazyInit } from "./lazy"
import Config from "react-native-config"
import { APP_NAME } from "../app/app.constants"

export interface SystemPromptEntry {
  id: string
  name: string
  content: string
  createdAt: number
  updatedAt: number
}

export const SYSTEM_PROMPT_NAME_MAX = 24

// ---------------------------------------------------------------------------
// Built-in read-only entries (stable reserved ids - uuid32 never collides)
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT_ASK_ID = "builtin-ask"
export const SYSTEM_PROMPT_CODE_ID = "builtin-code"

export const ASK_SYSTEM_PROMPT = `You are an assistant running inside ${Config.APP_NAME || APP_NAME}. You work in a "Project workspace": the workspace is a directory, and you can use tools to read, search, create, and edit files.
Rules:
- Inspect the workspace first: use list_files / search_files to locate relevant code, then read_file the specific parts. Prefer searching over blindly reading many files.
- To modify an existing file, prefer edit_file (exact string replacement) over rewriting the whole file. Use write_file only to create new files or when a full rewrite is truly needed.
- File writes require the user's approval unless auto-approval is enabled; this is expected behavior. A rejected write means the user declined - do not retry it.
- Writes are applied with exactly the content the user approved at confirmation time; the workspace may change while you wait. If the user says they modified files outside the chat, re-read them with read_file before assuming their contents.
- Only do what the user asks, and keep your answers concise.`

export const CODE_SYSTEM_PROMPT = `You are a coding agent running inside ${Config.APP_NAME || APP_NAME}. You work in a "Project workspace": the workspace is a directory, and you can use tools to read, search, create, and edit files.
Rules:
- Inspect before changing: use list_files / search_files to locate the relevant code, then read_file the specific parts; never assume file contents.
- Follow the project's existing language, style and conventions; make the smallest change that correctly implements the request.
- Prefer edit_file (exact string replacement) over rewriting whole files. Use write_file only to create new files or when a full rewrite is truly needed.
- File writes require the user's approval unless auto-approval is enabled; this is expected behavior. A rejected write means the user declined - do not retry it.
- Only do what the user asks, and keep your answers concise.`

/** Fresh objects per call - built-ins must never be mutated through the store's update paths. */
export function builtinSystemPrompts(): SystemPromptEntry[] {
  return [
    { id: SYSTEM_PROMPT_ASK_ID, name: "Ask", content: ASK_SYSTEM_PROMPT, createdAt: 0, updatedAt: 0 },
    { id: SYSTEM_PROMPT_CODE_ID, name: "Code", content: CODE_SYSTEM_PROMPT, createdAt: 0, updatedAt: 0 },
  ]
}

export function isBuiltinSystemPromptId(id: string | null | undefined): boolean {
  return id === SYSTEM_PROMPT_ASK_ID || id === SYSTEM_PROMPT_CODE_ID
}

function validEntry(value: unknown): value is SystemPromptEntry {
  const e = value as SystemPromptEntry
  return (
    !!e &&
    typeof e.id === "string" &&
    typeof e.name === "string" &&
    typeof e.content === "string" &&
    typeof e.createdAt === "number" &&
    typeof e.updatedAt === "number"
  )
}

/** Name checks (single source of the en-US copy for dialogs + notices): non-empty, ≤ cap, unique case-insensitively. */
export function validatePromptName(raw: string, taken: (lower: string) => boolean): string | null {
  const name = raw.trim()
  if (!name) return "Name cannot be empty"
  if (name.length > SYSTEM_PROMPT_NAME_MAX) return `Name cannot be longer than ${SYSTEM_PROMPT_NAME_MAX} characters`
  if (taken(name.toLowerCase())) return "A prompt with this name already exists"
  return null
}

class SystemPromptStore {
  private prompts: SystemPromptEntry[] = []

  async load(): Promise<void> {
    await ensureDir(appRootPath())
    const path = this.path()
    if (!(await exists(path))) return
    try {
      const raw = JSON.parse(await readText(path)) as { prompts?: unknown }
      this.prompts = Array.isArray(raw.prompts) ? (raw.prompts.filter(validEntry) as SystemPromptEntry[]) : []
    } catch {
      this.prompts = []
    }
  }

  private path(): string {
    return joinPath(appRootPath(), "system-prompts.json")
  }

  private async persist(): Promise<void> {
    await atomicWriteText(this.path(), JSON.stringify({ prompts: this.prompts }, null, 2))
  }

  /** CRUD page + picker order: built-ins pinned first (Ask, Code), then stored rows localeCompare by name. */
  list(): SystemPromptEntry[] {
    return [...builtinSystemPrompts(), ...[...this.prompts].sort((a, b) => a.name.localeCompare(b.name))]
  }

  /** Resolution view used by the send path / UI: built-in or stored entry. */
  get(id: string | null | undefined): SystemPromptEntry | undefined {
    if (!id) return undefined
    return builtinSystemPrompts().find((b) => b.id === id) ?? this.prompts.find((p) => p.id === id)
  }

  private storedOnly(id: string): SystemPromptEntry | undefined {
    return this.prompts.find((p) => p.id === id)
  }

  nameTaken(raw: string, exceptId?: string): boolean {
    const lower = raw.trim().toLowerCase()
    if (builtinSystemPrompts().some((b) => b.name.toLowerCase() === lower)) return true
    return this.prompts.some((p) => p.id !== exceptId && p.name.toLowerCase() === lower)
  }

  async create(name: string, content: string): Promise<SystemPromptEntry> {
    return this.createAt(uuid32(), name, content)
  }

  /**
   * Id-preserving create used by the System prompt YAML import (rule 38). Built-in ids are reserved and a
   * colliding stored id is rejected - the import checks first, this guard backstops direct callers.
   */
  async createWithId(id: string, name: string, content: string): Promise<SystemPromptEntry> {
    if (isBuiltinSystemPromptId(id)) throw new Error(`id "${id}" is reserved by a built-in prompt`)
    if (this.storedOnly(id)) throw new Error("a prompt with this id already exists")
    return this.createAt(id, name, content)
  }

  private async createAt(id: string, name: string, content: string): Promise<SystemPromptEntry> {
    const entry: SystemPromptEntry = { id, name: name.trim(), content, createdAt: Date.now(), updatedAt: Date.now() }
    this.prompts.push(entry)
    await this.persist()
    return entry
  }

  async rename(id: string, name: string): Promise<void> {
    const entry = this.storedOnly(id)
    if (!entry) return
    entry.name = name.trim()
    entry.updatedAt = Date.now()
    await this.persist()
  }

  async setContent(id: string, content: string): Promise<void> {
    const entry = this.storedOnly(id)
    if (!entry) return
    entry.content = content
    entry.updatedAt = Date.now()
    await this.persist()
  }

  async remove(id: string): Promise<void> {
    const idx = this.prompts.findIndex((p) => p.id === id)
    if (idx === -1) return
    this.prompts.splice(idx, 1)
    await this.persist()
  }
}

export const kSystemPromptStore = lazyInit<SystemPromptStore>(() => new SystemPromptStore())

/** Shared TextEditor validation for prompt/skill bodies: blank text stays put with an en-US notice. */
export function contentNotBlank(text: string): { ok: true; value: string } | { ok: false; message: string } {
  return text.trim().length > 0 ? { ok: true, value: text } : { ok: false, message: "The content cannot be empty" }
}
