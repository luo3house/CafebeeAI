/**
 * Conversation UI state: per-conversation `project-meta/<id>/ui/conversation_<convId>.json` = { draft, lastReadId }.
 * Separate from chat history (high-frequency small writes never rewrite the history JSON); memory is authoritative, persisted atomically with 800ms debounce;
 * forced-flush points = conversation evicted by LRU / app entering background / conversation deleted. The export zip excludes this directory (UI state is not user data).
 * - draft: input box draft (cleared on send).
 * - lastReadId: id of the last-read assistant message (gates the "Error" badge; condition = newest terminal assistant message id !== lastReadId).
 */
import { joinPath, ensureDir, listDir, readText, exists, atomicWriteText, unlink, projectMetaDir } from "./fs"

export interface ConversationUiState {
  draft: string
  lastReadId: string | null
}

const DEFAULT_STATE: ConversationUiState = { draft: "", lastReadId: null }

const WRITE_DEBOUNCE_MS = 800

function uiDir(projectId: string): string {
  return joinPath(projectMetaDir(projectId), "ui")
}

function uiFilePath(projectId: string, convId: string): string {
  return joinPath(uiDir(projectId), `conversation_${convId}.json`)
}

function stateKey(projectId: string, convId: string): string {
  return `${projectId}/${convId}`
}

const memory = new Map<string, ConversationUiState>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export function getUiStateSync(projectId: string, convId: string): ConversationUiState {
  return memory.get(stateKey(projectId, convId)) ?? { ...DEFAULT_STATE }
}

/** Load into memory (returns directly when cached); corrupted/missing file falls back to defaults */
export async function loadUiState(projectId: string, convId: string): Promise<ConversationUiState> {
  const key = stateKey(projectId, convId)
  const cached = memory.get(key)
  if (cached) return cached
  let state: ConversationUiState = { ...DEFAULT_STATE }
  try {
    if (await exists(uiFilePath(projectId, convId))) {
      const parsed = JSON.parse(await readText(uiFilePath(projectId, convId))) as Partial<ConversationUiState>
      state = {
        draft: typeof parsed?.draft === "string" ? parsed.draft : "",
        lastReadId: typeof parsed?.lastReadId === "string" ? parsed.lastReadId : null,
      }
    }
  } catch {
    // treat corrupted files as defaults
  }
  memory.set(key, state)
  return state
}

/** Bulk-load the UI state of every conversation in a project (badges need lastReadId) */
export async function loadProjectUiStates(projectId: string): Promise<Record<string, ConversationUiState>> {
  const out: Record<string, ConversationUiState> = {}
  const dir = uiDir(projectId)
  if (!(await exists(dir))) return out
  let names: string[] = []
  try {
    names = await listDir(dir)
  } catch {
    return out
  }
  for (const name of names) {
    if (!name.startsWith("conversation_") || !name.endsWith(".json")) continue
    const convId = name.slice("conversation_".length, -".json".length)
    if (convId) out[convId] = await loadUiState(projectId, convId)
  }
  return out
}

/** Update (merge) the in-memory state and persist with debounce */
export function updateUiState(projectId: string, convId: string, patch: Partial<ConversationUiState>): void {
  const key = stateKey(projectId, convId)
  const current = memory.get(key) ?? { ...DEFAULT_STATE }
  const next = { ...current, ...patch }
  memory.set(key, next)
  const existing = timers.get(key)
  if (existing) clearTimeout(existing)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      void flushUiState(projectId, convId)
    }, WRITE_DEBOUNCE_MS)
  )
}

/** Persist immediately (can target a single conversation; with no arguments flushes all dirty entries) */
export async function flushUiState(projectId?: string, convId?: string): Promise<void> {
  for (const [key, state] of [...memory.entries()]) {
    const sep = key.indexOf("/")
    const pid = key.slice(0, sep)
    const cid = key.slice(sep + 1)
    if (projectId && pid !== projectId) continue
    if (convId && cid !== convId) continue
    const timer = timers.get(key)
    if (timer) {
      clearTimeout(timer)
      timers.delete(key)
    }
    try {
      await ensureDir(uiDir(pid))
      await atomicWriteText(uiFilePath(pid, cid), JSON.stringify(state))
    } catch {
      // disk-write failure is silent (in-memory state persists, retried on the next flush)
    }
  }
}

/** Cascade cleanup on conversation deletion (first cancel the un-flushed debounce, then delete file and memory) */
export async function removeUiState(projectId: string, convId: string): Promise<void> {
  const key = stateKey(projectId, convId)
  const timer = timers.get(key)
  if (timer) {
    clearTimeout(timer)
    timers.delete(key)
  }
  memory.delete(key)
  await unlink(uiFilePath(projectId, convId))
}

/** Project-deletion scenarios: release every in-memory entry of the project (the files themselves die with removeProject's two-tree delete) */
export function dropProjectUiStates(projectId: string): void {
  const prefix = `${projectId}/`
  for (const key of [...memory.keys()]) {
    if (key.startsWith(prefix)) {
      memory.delete(key)
      const timer = timers.get(key)
      if (timer) {
        clearTimeout(timer)
        timers.delete(key)
      }
    }
  }
}
