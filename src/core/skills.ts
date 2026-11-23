/**
 * Global Skills registry + slash matching (rule 36): plain-text snippets shared by every Project, stored in
 * `<appRoot>/skills.json`. Typing `/name` in the chat draft and terminating the token (any non-name character -
 * space, punctuation, CJK - or the message send) expands the token in place with the skill's text; expansion is
 * automatic and the only "escape" is backspacing the inserted text. Skills are NOT offered to the model via a
 * tool_call (out of scope for this feature).
 *
 * Token grammar (R3-Q1): skill names are `[A-Za-z0-9_-]+` (≤ 24, unique case-insensitively); a `/` only starts a
 * token at the string start or after a non-name character (so `and/or`, `https://host/api` never match); the name
 * runs to the first non-name character, which is the terminator.
 *
 * Expansion mechanics (consensus R2-Q2=乙 + R1-Q5=A1):
 * - per keystroke/paste only: expand COMPLETE tokens whose terminator character index falls inside the changed
 *   region [commonPrefix, length-commonSuffix) of THIS edit - text before the region was already settled by its own
 *   edit event, and a body inserted by a previous expansion sits fully before the region, so bodies are never
 *   rescanned (single pass, no recursion of expansion-inserted content);
 * - send time: one final sweep over the whole text - any complete token expands and a trailing unterminated token
 *   (e.g. a token left restored by ui-state that nobody typed further) treats the string end as terminator.
 * The sweep operates on the message content; the visible draft stays intact until the normal send-clear.
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
    const entry: SkillEntry = {
      id: uuid32(),
      name: name.trim(),
      content,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
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
  /** index just past the name run = index of the terminator char (or text length when the run ends the string) */
  end: number
  lowerName: string
}

/** Left-to-right single pass over `src`: collected syntactically complete/running tokens; emitted output slices in
 *  between are copied verbatim, so replacement bodies are never part of the scan (no recursion within a pass). */
function scanTokens(src: string, collect: (hit: TokenHit, isEnd: boolean) => string | null): string {
  let out = ""
  let i = 0
  while (i < src.length) {
    if (src[i] === "/" && (i === 0 || !isNameChar(src[i - 1]))) {
      let j = i + 1
      while (j < src.length && isNameChar(src[j])) j++
      if (j > i + 1) {
        const isEnd = j === src.length
        const hit: TokenHit = { start: i, end: j, lowerName: src.slice(i + 1, j).toLowerCase() }
        const body = collect(hit, isEnd)
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

function diffRegion(prev: string, next: string): { from: number; to: number } {
  let p = 0
  const min = Math.min(prev.length, next.length)
  while (p < min && prev[p] === next[p]) p++
  let sc = 0
  while (sc < next.length - p && sc < prev.length - p && prev[prev.length - 1 - sc] === next[next.length - 1 - sc]) sc++
  return { from: p, to: next.length - sc }
}

/**
 * Per-edit expansion: only terminate-inside-the-changed-region complete tokens fire (terminator at index j means the
 * non-name character that closed the run; a token ending the string has no terminator and waits for the next keystroke
 * or the send sweep). `prev` is the draft BEFORE this change (entry.draft raw value).
 */
export function expandSkillsOnEdit(prev: string, next: string, lookup: ContentLookup): string {
  if (prev === next) return next
  const { from, to } = diffRegion(prev, next)
  if (from >= to) return next
  return scanTokens(next, (hit, isEnd) => {
    if (isEnd || hit.end < from || hit.end >= to) return null
    return lookup(hit.lowerName) ?? null
  })
}

/** Send sweep: every complete token expands and a trailing token treats the string end as its terminator. */
export function expandSkillsAtSend(text: string, lookup: ContentLookup): string {
  return scanTokens(text, (hit) => lookup(hit.lowerName) ?? null)
}

/** The in-progress trailing token's typed name (or "" for a bare "/"), or null when no token is being typed. */
export function trailingSlashInput(text: string): string | null {
  const m = TRAILING_SLASH_RE.exec(text)
  return m ? m[1] : null
}
