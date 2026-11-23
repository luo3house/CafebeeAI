/**
 * Chat session registry (valtio): supports multi-Project × multi-conversation parallel WIP (the "single active stream" is abolished).
 * - One resident SessionEntry per (projectId, convId) (messages/streaming state/draft);
 * - WIP conversations (a turn running, including waiting on card confirmation / a form) are pinned and never evicted; idle non-WIP conversations evict by LRU, capacity 10, force-flushed to disk before eviction;
 * - Bound conversation = the entry pointed to by (runtime.currentProjectId, runtime.currentConversationId);
 *   switching the binding interrupts no running turn (the orchestration layer llm/chat.ts holds the entry reference and writes its state directly).
 * - Turn runtime handles (abort/turnSeq) are stored per conversation in this module (non-proxy), used by llm/chat.ts;
 *   stop/delete/evict paths can reach them via abortTurnHandle.
 * - Persistence: llm flushUI keeps the 60ms proxy-write gate, and display updates are coalesced again in
 *   the view layer (MessageList's useSnapshotCustom, debounce 150ms / maxWait 300ms); disk writes go
 *   through schedulePersist's 800ms debounce, and persistNow stringifies a valtio derived snapshot
 *   asynchronously (yieldable-json, see core/async-json); turn wrap-up / send / background / eviction /
 *   deletion always force-flush with persistNow + flushUiState.
 */
import { proxy, snapshot } from "valtio"
import { runtime } from "./runtime"
import { cancelFormsFor } from "./formflow"
import { cancelWriteConfirmationsFor } from "./toolflow"
import { kChatStore, lastTerminalAssistantId, type ChatMessage, type Conversation } from "../core/chats"
import { loadUiState, updateUiState, flushUiState } from "../core/ui-state"

export interface SessionEntry {
  projectId: string
  convId: string
  conversation: Conversation
  messages: ChatMessage[]
  /** Input-box draft (cleared on send, debounced to a separate file) */
  draft: string
  streaming: boolean
  stopped: boolean
  error: string | null
  lastErrorAt: number
  /** LRU timestamp (non-reactive use, eviction ordering only) */
  lastUsedAt: number
}

export const chatSessions = proxy<Record<string, SessionEntry>>({})

/**
 * Low-frequency draft slice (sessionKey -> text): ChatInputBar subscribes here with useSnapshot(..., {sync:true}),
 * so typing re-renders only the input bar; stream flushes never touch this proxy. entry.draft stays mirrored
 * for the registry semantics (UI-state restore / send path read it as raw data), draftStore is the render source.
 */
export const draftStore = proxy<Record<string, string>>({})

/** Proxy-reference table of loaded entries (module-internal, avoids repeated unwrapping) */
const entries = new Map<string, SessionEntry>()

export function sessionKey(projectId: string, convId: string): string {
  return `${projectId}/${convId}`
}

export function getEntry(projectId: string | null, convId: string | null): SessionEntry | undefined {
  if (!projectId || !convId) return undefined
  return entries.get(sessionKey(projectId, convId))
}

export function boundKey(): string | null {
  const { currentProjectId, currentConversationId } = runtime
  if (!currentProjectId || !currentConversationId) return null
  return sessionKey(currentProjectId, currentConversationId)
}

function isBound(entry: SessionEntry): boolean {
  return sessionKey(entry.projectId, entry.convId) === boundKey()
}

function isWip(entry: SessionEntry): boolean {
  return entry.streaming || isBound(entry)
}

// ---------------------------------------------------------------------------
// Turn runtime handles (non-proxy): abort + generation number
// ---------------------------------------------------------------------------

export interface TurnHandle {
  seq: number
  abort: AbortController | null
}

const turnHandles = new Map<string, TurnHandle>()

export function turnHandle(projectId: string, convId: string): TurnHandle {
  const key = sessionKey(projectId, convId)
  let h = turnHandles.get(key)
  if (!h) {
    h = { seq: 0, abort: null }
    turnHandles.set(key, h)
  }
  return h
}

/** Abort this conversation's running turn (does not change stopped semantics; the caller decides how to mark it) */
export function abortTurnHandle(projectId: string, convId: string): void {
  const h = turnHandle(projectId, convId)
  h.seq++
  h.abort?.abort()
  h.abort = null
}

// ---------------------------------------------------------------------------
// Persistence scheduling (message files)
// ---------------------------------------------------------------------------

const PERSIST_DEBOUNCE_MS = 800
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function schedulePersist(entry: SessionEntry): void {
  const key = sessionKey(entry.projectId, entry.convId)
  if (persistTimers.has(key)) return
  persistTimers.set(
    key,
    setTimeout(() => {
      persistTimers.delete(key)
      void persistNow(entry)
    }, PERSIST_DEBOUNCE_MS)
  )
}

export async function persistNow(entry: SessionEntry): Promise<void> {
  const key = sessionKey(entry.projectId, entry.convId)
  const timer = persistTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    persistTimers.delete(key)
  }
  // An evicted/released entry must never write back (prevents deleted conversations from "resurrecting" and stale copies from overwriting)
  if (entries.get(key) !== entry) return
  try {
    // Hand the async encoder a valtio derived snapshot (stable plain tree, cached - O(n) shallow at worst):
    // the raw streaming message is mutated in place between flushes, and yieldable-json forbids mutation mid-run.
    await kChatStore().saveMessages(
      entry.projectId,
      snapshot(entry.conversation) as Conversation,
      snapshot(entry.messages) as unknown as ChatMessage[]
    )
  } catch {
    // Disk-write failures are silent (same as the old persistCurrent; blob-util's serialized queue guarantees no cross-stomping)
  }
}

/** Background/eviction/full wrap-up: force-flush all resident conversations (messages + UI state) */
export async function flushAllSessions(): Promise<void> {
  for (const entry of [...entries.values()]) {
    await persistNow(entry)
    await flushUiState(entry.projectId, entry.convId)
  }
}

// ---------------------------------------------------------------------------
// LRU eviction (capacity 10, evicts only non-WIP, non-bound conversations)
// ---------------------------------------------------------------------------

const LRU_CAPACITY = 10

function touch(entry: SessionEntry): void {
  entry.lastUsedAt = Date.now()
}

function evictIfNeeded(): void {
  const candidates: SessionEntry[] = []
  for (const entry of entries.values()) {
    if (!isWip(entry)) candidates.push(entry)
  }
  if (candidates.length <= LRU_CAPACITY) return
  candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
  for (const entry of candidates.slice(0, candidates.length - LRU_CAPACITY)) {
    void (async () => {
      await persistNow(entry)
      await flushUiState(entry.projectId, entry.convId)
      // The user may have re-entered/restarted this conversation during the flush: re-check before dropping to avoid killing an active conversation
      if (isWip(entry)) return
      dropEntry(entry)
    })()
  }
}

function dropEntry(entry: SessionEntry): void {
  const key = sessionKey(entry.projectId, entry.convId)
  entries.delete(key)
  turnHandles.delete(key)
  delete draftStore[key]
  const timer = persistTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    persistTimers.delete(key)
  }
  delete chatSessions[key]
}

/**
 * Release a conversation (before deletion): bump the generation number so old turns can no longer write state/persist, abort the running request,
 * cancel this conversation's pending forms/write confirmations, and remove the entry. Deleting the disk files is the caller's kChatStore().remove job.
 */
export function releaseConversation(projectId: string, convId: string): void {
  const key = sessionKey(projectId, convId)
  const entry = entries.get(key)
  const handle = turnHandles.get(key)
  if (handle) {
    handle.seq++
    handle.abort?.abort()
    handle.abort = null
    turnHandles.delete(key)
  }
  if (entry) {
    entry.stopped = true
    cancelFormsFor(projectId, convId)
    cancelWriteConfirmationsFor(projectId, convId)
    dropEntry(entry)
  }
}

/** Project deletion: abort all of the project's turns and release their entries (the caller then runs removeProject) */
export function dropProjectSessions(projectId: string): void {
  for (const entry of [...entries.values()]) {
    if (entry.projectId !== projectId) continue
    abortTurnHandle(entry.projectId, entry.convId)
    dropEntry(entry)
  }
}

// ---------------------------------------------------------------------------
// Read receipts / drafts / metadata
// ---------------------------------------------------------------------------

/** Mark-read = the id of the last "terminal" assistant message (streaming messages can never be marked read, guarding against "peeked mid-stream, later finalization fails and the reminder is lost") */
export function touchLastRead(entry: SessionEntry): void {
  const lastId = lastTerminalAssistantId(entry.messages as ChatMessage[])
  updateUiState(entry.projectId, entry.convId, { lastReadId: lastId })
}

export function setDraft(entry: SessionEntry, text: string): void {
  entry.draft = text
  draftStore[sessionKey(entry.projectId, entry.convId)] = text
  updateUiState(entry.projectId, entry.convId, { draft: text })
}

/**
 * Single entry point for conversation-metadata changes: resident conversations mutate the object via the registry, then persist
 * (prevents a debounced persist from clobbering a rename/binding change with a stale copy); non-resident ones use storage-layer read-modify-write.
 */
export async function updateConversationMeta(
  projectId: string,
  convId: string,
  patch: Partial<Pick<Conversation, "title" | "systemPromptId" | "providerId" | "model" | "summaryAt">>
): Promise<void> {
  const entry = getEntry(projectId, convId)
  if (entry) {
    Object.assign(entry.conversation, patch)
    await persistNow(entry)
    return
  }
  await kChatStore().updateMeta(projectId, convId, patch)
}

// ---------------------------------------------------------------------------
// Loading and binding
// ---------------------------------------------------------------------------

/** Fetch or load an entry (cache hit = zero IO; miss = read the chat file + the UI-state file) */
export async function ensureEntry(projectId: string, convId: string): Promise<SessionEntry> {
  const key = sessionKey(projectId, convId)
  const cached = entries.get(key)
  if (cached) {
    touch(cached)
    return cached
  }
  const [{ conversation, messages }, ui] = await Promise.all([
    kChatStore().get(projectId, convId),
    loadUiState(projectId, convId),
  ])
  const draft = ui.draft
  const created: SessionEntry = {
    projectId,
    convId,
    conversation,
    messages,
    draft,
    streaming: false,
    stopped: false,
    error: null,
    lastErrorAt: 0,
    lastUsedAt: Date.now(),
  }
  chatSessions[key] = created
  const entry = chatSessions[key]!
  entries.set(key, entry)
  draftStore[key] = draft
  touch(entry)
  evictIfNeeded()
  return entry
}

/**
 * Bind a conversation: switch to (projectId, convId) and load the entry.
 * markRead=true is only for **explicit user entry** (tapping a list row / header switch / entering after create / sending);
 * automatic programmatic binding (project-switch landing, cold-start landing, post-deletion fallback) passes false — never swallow badges (prefer a false positive to a false negative).
 */
export async function bindConversation(
  projectId: string,
  convId: string,
  opts?: { markRead?: boolean }
): Promise<SessionEntry> {
  const entry = await ensureEntry(projectId, convId)
  runtime.currentProjectId = projectId
  runtime.currentConversationId = convId
  touch(entry)
  if (opts?.markRead) touchLastRead(entry)
  return entry
}
