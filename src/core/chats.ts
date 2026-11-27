/**
 * Conversation and message storage: one file per conversation `project-meta/<id>/chats/<uuid>.json`
 * (conversation+messages), atomic writes. Deleting a conversation cascades cleanup of
 * `project-meta/<id>/ui/conversation_<convId>.json` (draft/read state).
 * Encoding is async-chunked (core/async-json stringifyAsyncSafe) so a large history no longer blocks the JS
 * thread in one JSON.stringify; decoding stays on native JSON.parse (yieldable-json's parseAsync is unusable
 * on Hermes and slower than native anyway).
 */
import { joinPath, ensureDir, listDir, exists, readText, atomicWriteText, unlink, projectMetaDir } from "./fs"
import { uuid32 } from "./uuid"
import { lazyInit } from "./lazy"
import { removeUiState } from "./ui-state"
import { stringifyAsyncSafe } from "./async-json"

export type MessagePartText = { type: "text"; text: string }
export type MessagePartAttachment = { type: "attachment"; name: string; content: string; truncated?: boolean }
export type MessagePartReasoning = { type: "reasoning"; text: string }
export type ToolCallKind = "read_file" | "write_file" | "list_files" | "show_form" | "search_files" | "edit_file" | "download_file" | "run_javascript"
export type MessagePartToolCall = {
  type: "tool_call"
  id: string
  name: ToolCallKind
  args: Record<string, unknown>
  result?: string
  status?: "running" | "ok" | "error" | "rejected"
  error?: string
}
export type MessagePart = MessagePartText | MessagePartAttachment | MessagePartReasoning | MessagePartToolCall

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  parts: MessagePart[]
  createdAt: number
  state?: "streaming" | "stopped" | "error" | "done"
  error?: string
}

export interface Conversation {
  id: string
  title: string
  /**
   * Conversation-level System Prompt binding: id of an entry in the global registry (`core/system-prompts.ts`).
   * Absent - or an id whose entry has been deleted - falls back to the built-in Default prompt at send time
   * (lazy, nothing rewritten on delete; rule 35). The legacy inline `systemPrompt` string field was dropped on
   * 2026-11-23 (clean break: old files may still carry it, nothing reads it anymore).
   */
  systemPromptId?: string
  /** Conversation auto-summarization time (ISO string). Empty/null for new conversations; when the first Q&A round finishes and it is empty, stamp the current time and trigger summarization (one-shot, no retry regardless of outcome) */
  summaryAt?: string | null
  /** Session-level model binding (sticky): written by the pre-send picker / modelBar toggle; falls back to project preference prefer_provider when absent */
  providerId?: string
  /** Session-level model binding: model name */
  model?: string
  createdAt: number
  updatedAt: number
}

/** list() summary: conversation metadata + the last assistant message status needed for badge decisions */
export interface ConversationBrief {
  conversation: Conversation
  lastAssistantId: string | null
  lastAssistantIsError: boolean
}

interface ConversationFile {
  conversation: Conversation
  messages: ChatMessage[]
}

/** id of the last assistant message in a terminal state (not streaming) — the landing point for marking read on "entering a conversation / sending" */
export function lastTerminalAssistantId(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "assistant" && m.state !== "streaming") return m.id
  }
  return null
}

function chatsDir(projectId: string): string {
  return joinPath(projectMetaDir(projectId), "chats")
}

function chatFilePath(projectId: string, convId: string): string {
  return joinPath(chatsDir(projectId), `${convId}.json`)
}

/** Disk-read fallback: files from history/abnormal writes may contain parts with text null/undefined (missing fields in JSON); normalize them to strings;
 * also repair cold-start residue: turns left unfinished when the app was killed — finalize streaming messages as stopped ("Interrupted by user"),
 * give unfinished tool parts (status running/absent with no result) an error (show_form gets form_aborted, the rest get aborted) —
 * so subsequent rounds get legal toWireMessages and the model is informed; repairs must be persisted. */
function sanitizeMessages(messages: ChatMessage[]): { messages: ChatMessage[]; fixed: boolean } {
  let fixed = false
  for (const msg of messages) {
    if (msg.state === "streaming") {
      msg.state = "stopped"
      msg.error = "Interrupted by user"
      fixed = true
    }
    if (!Array.isArray(msg.parts)) msg.parts = []
    for (const raw of msg.parts as Array<Record<string, unknown>>) {
      const kind = raw.type
      if (kind === "text" || kind === "reasoning") {
        if (typeof raw.text !== "string") raw.text = ""
      } else if (kind === "attachment") {
        if (typeof raw.content !== "string") raw.content = ""
        if (typeof raw.name !== "string") raw.name = ""
      } else if (kind === "tool_call") {
        const status = raw.status
        const hasOutcome = raw.result !== undefined || typeof raw.error === "string"
        if (!hasOutcome && (status === "running" || status === undefined)) {
          raw.status = "error"
          raw.error =
            raw.name === "show_form"
              ? "form_aborted: The form was not completed because the app restarted."
              : "aborted: The tool did not complete because the app restarted."
          fixed = true
        }
      }
    }
  }
  return { messages, fixed }
}

class ChatStore {
  /** Read all conversation files and return badge summaries (corrupted files skipped; no repair persisted — orphan finalization happens in get()) */
  async list(projectId: string): Promise<ConversationBrief[]> {
    const dir = chatsDir(projectId)
    if (!(await exists(dir))) return []
    const names = await listDir(dir)
    const out: ConversationBrief[] = []
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      try {
        const raw = await readText(joinPath(dir, name))
        const parsed = JSON.parse(raw) as ConversationFile
        if (parsed && parsed.conversation && parsed.conversation.id) {
          const messages = Array.isArray(parsed.messages) ? parsed.messages : []
          let lastAssistantId: string | null = null
          let lastAssistantIsError = false
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "assistant") {
              lastAssistantId = messages[i].id
              lastAssistantIsError = messages[i].state === "error"
              break
            }
          }
          out.push({ conversation: parsed.conversation, lastAssistantId, lastAssistantIsError })
        }
      } catch {
        // corrupted file skipped
      }
    }
    out.sort((a, b) => b.conversation.updatedAt - a.conversation.updatedAt)
    return out
  }

  async get(projectId: string, convId: string): Promise<{ conversation: Conversation; messages: ChatMessage[] }> {
    const path = chatFilePath(projectId, convId)
    if (await exists(path)) {
      try {
        const parsed = JSON.parse(await readText(path)) as ConversationFile
        const sanitized = sanitizeMessages(Array.isArray(parsed.messages) ? parsed.messages : [])
        if (sanitized.fixed) {
          // cold-start residue repairs must be persisted to avoid re-repairing on every read
          try {
            await this.persist(projectId, parsed.conversation, sanitized.messages)
          } catch {}
        }
        return { conversation: parsed.conversation, messages: sanitized.messages }
      } catch {
        // fallthrough to empty
      }
    }
    const conversation: Conversation = {
      id: convId,
      title: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    return { conversation, messages: [] }
  }

  async create(projectId: string, opts?: { title?: string }): Promise<Conversation> {
    const conversation: Conversation = {
      id: uuid32(),
      title: opts?.title?.trim() || "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await this.persist(projectId, conversation, [])
    return conversation
  }

  /** Generic read-modify-write entry for conversation metadata (non-resident path; title/systemPromptId/model binding/summaryAt etc.).
   * Resident conversations must go through state/chat.updateConversationMeta (mutate the object via the registry then persist, preventing a debounced write-back of a stale copy). */
  async updateMeta(projectId: string, convId: string, patch: Partial<Conversation>): Promise<void> {
    const { conversation, messages } = await this.get(projectId, convId)
    Object.assign(conversation, patch, { id: conversation.id })
    conversation.updatedAt = Date.now()
    await this.persist(projectId, conversation, messages)
  }

  async remove(projectId: string, convId: string): Promise<void> {
    const path = chatFilePath(projectId, convId)
    await unlink(path)
    await removeUiState(projectId, convId)
  }

  async saveMessages(projectId: string, conversation: Conversation, messages: ChatMessage[]): Promise<void> {
    // Never mutate the incoming conversation: the resident path hands in a valtio derived snapshot
    // (a plain tree that rebuilds rather than mutates); spreading keeps the same behavior
    // (updatedAt refresh) for plain callers too.
    await this.persist(projectId, { ...conversation, updatedAt: Date.now() }, messages)
  }

  private async persist(
    projectId: string,
    conversation: Conversation,
    messages: ChatMessage[]
  ): Promise<void> {
    await ensureDir(chatsDir(projectId))
    const payload: ConversationFile = { conversation, messages }
    const text = await stringifyAsyncSafe(payload)
    await atomicWriteText(chatFilePath(projectId, conversation.id), text)
  }
}

export const kChatStore = lazyInit<ChatStore>(() => new ChatStore())