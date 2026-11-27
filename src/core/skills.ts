/**
 * Global Skills registry + slash matching (rule 36): plain-text snippets shared by every Project, stored in
 * `<appRoot>/skills.json`. The chat draft keeps the raw `/name` token untouched (there is NO per-edit expansion
 * channel); at send time `llm/chat.ts` sweeps the outgoing text once and splices the matching skill's text into the
 * user message record. Skills are NOT offered to the model via a tool_call (out of scope for this feature).
 *
 * Token grammar (R3-Q1): skill names are `[A-Za-z0-9_-]+` (≤ 24, unique case-insensitively); a `/` only starts a
 * token at the string start or after a non-name character (so `and/or`, `https://host/api` never match); the name
 * runs greedily to the first non-name character.
 *
 * Expansion trigger (2026-11-26 rework): a token expands ONLY when its name run is followed by a half-width space
 * U+0020 - that space is the submit marker and is preserved verbatim (`/code 展开` -> `body 展开`). A token followed
 * by punctuation, CJK, a newline, or the end of the message is sent LITERALLY (`/code,`, `用/code展开`, a message
 * ending in `/code` all stay verbatim) - this literal-by-default behavior is also the escape; there is no backslash
 * syntax (`\` is an ordinary character). The only impossible literal is `/name ` (matched name + half-width space):
 * it always expands. Unmatched names go to the message verbatim, silently. Bodies are spliced in a single
 * left-to-right pass and never rescanned, so a `/token` inside a skill body never cascade-expands. Expansion happens
 * exactly once at send: drafts are never rewritten (the candidate-pill completion writes the token, never the body).
 */
import { joinPath, readText, ensureDir, exists, atomicWriteText, appRootPath } from "./fs"
import { uuid32 } from "./uuid"
import { lazyInit } from "./lazy"

export interface SkillEntry {
  id: string
  name: string
  content: string
  createdAt: number
  updatedAt: number
}

export const SKILL_NAME_MAX = 24
/** Slash-token grammar: identifiers are case-insensitively unique; no spaces (a token must be typeable as one run). */
export const SKILL_NAME_RE = /^[A-Za-z0-9_-]+$/

function validEntry(value: unknown): value is SkillEntry {
  const e = value as SkillEntry
  return (
    !!e &&
    typeof e.id === "string" &&
    typeof e.name === "string" &&
    typeof e.content === "string" &&
    typeof e.createdAt === "number" &&
    typeof e.updatedAt === "number"
  )
}

export function validateSkillName(raw: string, taken: (lower: string) => boolean): string | null {
  const name = raw.trim()
  if (!name) return "Name cannot be empty"
  if (name.length > SKILL_NAME_MAX) return `Name cannot be longer than ${SKILL_NAME_MAX} characters`
  if (!SKILL_NAME_RE.test(name)) return "Use letters, digits, hyphen, or underscore only"
  if (taken(name.toLowerCase())) return "A skill with this name already exists"
  return null
}

class SkillStore {
  private skills: SkillEntry[] = []
  /** lowercase name -> content (exact-match lookup for the scanner); rebuilt on every mutation. */
  private byLowerName = new Map<string, string>()

  async load(): Promise<void> {
    await ensureDir(appRootPath())
    const path = this.path()
    let entries: SkillEntry[] = []
    if (await exists(path)) {
      try {
        const raw = JSON.parse(await readText(path)) as { skills?: unknown }
        entries = Array.isArray(raw.skills) ? (raw.skills.filter(validEntry) as SkillEntry[]) : []
      } catch {
        entries = []
      }
    }
    this.skills = entries
    this.rebuildIndex()
  }

  private path(): string {
    return joinPath(appRootPath(), "skills.json")
  }

  private rebuildIndex(): void {
    this.byLowerName = new Map(this.skills.map((s) => [s.name.toLowerCase(), s.content]))
  }

  private async persist(): Promise<void> {
    await atomicWriteText(this.path(), JSON.stringify({ skills: this.skills }, null, 2))
    this.rebuildIndex()
  }

  list(): SkillEntry[] {
    return [...this.skills].sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: string): SkillEntry | undefined {
    return this.skills.find((s) => s.id === id)
  }

  contentFor(lowerName: string): string | undefined {
    return this.byLowerName.get(lowerName)
  }

  nameTaken(raw: string, exceptId?: string): boolean {
    const lower = raw.trim().toLowerCase()
    return this.skills.some((s) => s.id !== exceptId && s.name.toLowerCase() === lower)
  }

  /** Case-insensitive prefix match over the display order (candidate strip: "" lists everything). */
  candidateNames(prefixLower: string): string[] {
    return this.list()
      .map((s) => s.name)
      .filter((n) => n.toLowerCase().startsWith(prefixLower))
  }

  async create(name: string, content: string): Promise<SkillEntry> {
    return this.createAt(uuid32(), name, content)
  }

  /** Id-preserving create used by the Skill YAML import (rule 38): keeps a free `spec.id` verbatim. */
  async createWithId(id: string, name: string, content: string): Promise<SkillEntry> {
    if (this.get(id)) throw new Error("a skill with this id already exists")
    return this.createAt(id, name, content)
  }

  private async createAt(id: string, name: string, content: string): Promise<SkillEntry> {
    const entry: SkillEntry = { id, name: name.trim(), content, createdAt: Date.now(), updatedAt: Date.now() }
    this.skills.push(entry)
    await this.persist()
    return entry
  }

  async rename(id: string, name: string): Promise<void> {
    const entry = this.get(id)
    if (!entry) return
    entry.name = name.trim()
    entry.updatedAt = Date.now()
    await this.persist()
  }

  async setContent(id: string, content: string): Promise<void> {
    const entry = this.get(id)
    if (!entry) return
    entry.content = content
    entry.updatedAt = Date.now()
    await this.persist()
  }

  async remove(id: string): Promise<void> {
    const idx = this.skills.findIndex((s) => s.id === id)
    if (idx === -1) return
    this.skills.splice(idx, 1)
    await this.persist()
  }
}

export const kSkillStore = lazyInit<SkillStore>(() => new SkillStore())

// ---------------------------------------------------------------------------
// Slash scanning / expansion (pure helpers, store-agnostic)
// ---------------------------------------------------------------------------

const NAME_CHAR_RE = /[A-Za-z0-9_-]/
const TRAILING_SLASH_RE = /(?:^|[^A-Za-z0-9_-])\/([A-Za-z0-9_-]*)$/

function isNameChar(ch: string): boolean {
  return NAME_CHAR_RE.test(ch)
}

type ContentLookup = (lowerName: string) => string | undefined

interface TokenHit {
  /** index of the '/' */
  start: number
  /** index just past the name run = index of the U+0020 submit-marker space (when the token fires) */
  end: number
  lowerName: string
}

/** Left-to-right single pass over `src`: a token fires only when its name run is followed by the U+0020 submit-marker
 *  space; emitted output slices in between are copied verbatim, so replacement bodies are never part of the scan
 *  (no recursion within a pass). */
function scanTokens(src: string, collect: (hit: TokenHit) => string | null): string {
  let out = ""
  let i = 0
  while (i < src.length) {
    if (src[i] === "/" && (i === 0 || !isNameChar(src[i - 1]))) {
      let j = i + 1
      while (j < src.length && isNameChar(src[j])) j++
      if (j > i + 1 && src[j] === " ") {
        const hit: TokenHit = { start: i, end: j, lowerName: src.slice(i + 1, j).toLowerCase() }
        const body = collect(hit)
        if (body !== null) {
          out += body
          i = j
          continue
        }
      }
    }
    out += src[i]
    i++
  }
  return out
}

/** Send sweep: a token expands only when its name run is followed by the U+0020 submit-marker space (kept verbatim). */
export function expandSkillsAtSend(text: string, lookup: ContentLookup): string {
  return scanTokens(text, (hit) => lookup(hit.lowerName) ?? null)
}

/** The in-progress trailing token's typed name (or "" for a bare "/"), or null when no token is being typed. */
export function trailingSlashInput(text: string): string | null {
  const m = TRAILING_SLASH_RE.exec(text)
  return m ? m[1] : null
}

/**
 * Candidate-pill completion: replace the trailing in-progress token with the canonical `/<name> ` (the trailing
 * space is the submit-marker - sending the draft then expands it). Returns null when no token is being typed.
 */
export function completeTrailingSlash(text: string, name: string): string | null {
  const m = TRAILING_SLASH_RE.exec(text)
  if (!m) return null
  const slash = m.index + m[0].lastIndexOf("/")
  return `${text.slice(0, slash)}/${name} `
}
