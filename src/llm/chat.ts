/**
 * LLM orchestration: hand-written OpenAI Compatible multi-step agent loop (streaming + tools + reasoning + failure/stop/regenerate).
 * Multi-session parallelism WIP: all state hangs on SessionEntry (the state/chat registry); the module holds no global single-stream state —
 * abort / turnSeq are isolated per conversation via turnHandle(projectId, convId); turns of different conversations run concurrently and never overwrite each other.
 * **Timeouts only bite HTTP requests, never the flow**: network-silence detection is pushed down to openai-client's request-level idleTimeout (LLMIdleTimeoutError,
 * classified as a retryable network error); tool execution / pending card confirmation / form waiting have no timeouts at all (waiting for a human is a legal state).
 * The one download-side nuance: download_file's own HTTP request carries a request-level 300s no-data stall watchdog (progress-armed, cancel()-based) -
 * it still only bites the request, never the flow or any human wait.
 * Persistence: UI flush throttled at 60ms (fresh in-memory references); disk writes debounced 800ms (schedulePersist);
 * turn wrap-up / send / stop always force persistNow. Read receipts: if the conversation is still bound at turn wrap-up → touchLastRead;
 * unbound keeps the previous value (the failure badge lights up naturally via the "last answer id ≠ lastReadId" formula).
 * SSE parsing / tool_calls aggregation: see openai-client.ts; no longer depends on the Vercel AI SDK.
 */
import type { LLMProvider } from "../core/providers"
import { kProviderRegistry } from "../core/providers"
import Config from "react-native-config"
import { APP_NAME } from "../app/app.constants"
import { loadConfig } from "../core/config"
import { setProjectPreference } from "../core/projects"
import type { ChatMessage, MessagePartToolCall } from "../core/chats"
import {
  streamChatCompletion,
  postJSON,
  type AccumulatedToolCall,
  type StreamHandlers,
  type WireMessage,
  type WireTool,
} from "./openai-client"
import { buildTools, type ToolDef } from "./tools"
import {
  ensureEntry,
  getEntry,
  schedulePersist,
  persistNow,
  sessionKey,
  boundKey,
  touchLastRead,
  turnHandle,
  updateConversationMeta,
  type SessionEntry,
} from "../state/chat"
import { openModelPicker } from "../state/modelpicker"
import { cancelFormsFor, hasPendingFormFor } from "../state/formflow"
import { cancelWriteConfirmationsFor, hasPendingWriteFor } from "../state/toolflow"

/** Max model-call steps within one answer (tool-loop cap); the list→search→read→edit tool chain takes many steps, so leave generous headroom */
const MAX_STEPS = 15

/**
 * System prompt / tool descriptions / tool-result text sent to the model are always en-US;
 * user-facing UI copy (error records, buttons, Snackbar) is en-US everywhere as well.
 */
const DEFAULT_SYSTEM_PROMPT = `You are an assistant running inside ${Config.APP_NAME || APP_NAME}. You work in a "Project workspace": the workspace is a directory, and you can use tools to read, search, create, and edit files.
Rules:
- Inspect the workspace first: use list_files / search_files to locate relevant code, then read_file the specific parts. Prefer searching over blindly reading many files.
- To modify an existing file, prefer edit_file (exact string replacement) over rewriting the whole file. Use write_file only to create new files or when a full rewrite is truly needed.
- File writes require the user's approval unless auto-approval is enabled; this is expected behavior. A rejected write means the user declined - do not retry it.
- Writes are applied with exactly the content the user approved at confirmation time; the workspace may change while you wait. If the user says they modified files outside the chat, re-read them with read_file before assuming their contents.
- Only do what the user asks, and keep your answers concise.`

/**
 * Conversation-title auto-summary prompt (en-US, model-facing); the generated title follows the conversation's language, length is left to UI truncation.
 * This request is independent of chat history: not entered into conversation messages, doesn't occupy the conversation's streaming, not persisted to chat history; prompt en-US, ≤24 characters after cleaning.
 */
const TITLE_SYSTEM_PROMPT = `You are a title generator. Summarize the given conversation into a short title.
Rules:
- Reply with ONLY the title text. No quotes, no trailing punctuation, no explanation, single line.
- Prefer 8 Chinese characters or fewer (or up to 6 words if the conversation is not Chinese).
- Use the same language as the conversation.`

const titleInflight = new Set<string>()

function cleanGeneratedTitle(raw: string): string {
  const firstLine = (raw.split("\n").find((l) => l.trim()) ?? "").trim()
  return firstLine
    .replace(/^["'“‘「『【《]+/, "")
    .replace(/["'”’」』】》。.！!？?：:]+$/, "")
    .trim()
    .slice(0, 24)
}

/**
 * The single entry point for conversation auto-summarization: a one-shot decision keyed on the conversation's summary timestamp ISO (summaryAt).
 * After the first Q&A round, if summaryAt is empty → immediately stamp the current-time ISO and persist via the registry (claiming the slot), then send the summary request;
 * never trigger again afterwards (whether the summary succeeds or fails); an existing conversation title (manually named) is not overwritten; failures are silent.
 */
async function maybeSummarizeConversation(
  entry: SessionEntry,
  provider: LLMProvider,
  model: string
): Promise<void> {
  const conversation = entry.conversation
  if (conversation.summaryAt || titleInflight.has(conversation.id)) return
  titleInflight.add(conversation.id)
  try {
    const iso = new Date().toISOString()
    await updateConversationMeta(entry.projectId, entry.convId, { summaryAt: iso })
    if (entry.conversation.title.trim()) return
    const transcript = toWireMessages(entry.messages as ChatMessage[])
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n")
      .slice(0, 4000)
    if (!transcript.trim()) return
    const res = await postJSON<{ choices?: { message?: { content?: unknown } }[] }>(provider, "chat/completions", {
      model,
      stream: false,
      temperature: 0.2,
      messages: [
        { role: "system", content: TITLE_SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
    })
    const title = cleanGeneratedTitle(String(res?.choices?.[0]?.message?.content ?? ""))
    if (!title) return
    // Manual naming may have happened while waiting: the latest value wins
    if (entry.conversation.title.trim()) return
    await updateConversationMeta(entry.projectId, entry.convId, { title })
  } catch {
    // Auto-summary failure must not affect the conversation: stay silent (the timestamp is already claimed, no retry)
  } finally {
    titleInflight.delete(entry.convId)
  }
}

/** Map this project's messages into OpenAI wire messages (everything but system; includes replay of historical tool calls and results) */
function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = []
  for (const msg of messages) {
    if (msg.role === "user") {
      const segs: string[] = []
      for (const part of msg.parts) {
        if (part.type === "text") segs.push(part.text ?? "")
        else if (part.type === "attachment") segs.push(`[Attached file: ${part.name}]\n${part.content}`)
      }
      out.push({ role: "user", content: segs.length ? segs.join("\n") : "" })
    } else {
      const text = msg.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text?: string }).text ?? "")
        .join("\n")
      const toolCalls = msg.parts.filter((p): p is MessagePartToolCall => p.type === "tool_call")
      if (!text && toolCalls.length === 0) continue
      const assistantMsg: WireMessage = { role: "assistant", content: text || null }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        }))
      }
      out.push(assistantMsg)
      for (const tc of toolCalls) {
        let content: string
        if (tc.error || tc.status === "error" || tc.status === "rejected") {
          // Same shape as the runtime failure result (JSON envelope), so replay feeds the model exactly the live-turn format
          content = JSON.stringify({ ok: false, rejected: tc.status === "rejected", error: tc.error ?? "Tool execution failed" })
        } else if (tc.result !== undefined) {
          content = tc.result
        } else {
          content = "{}"
        }
        out.push({ role: "tool", tool_call_id: tc.id, content })
      }
    }
  }
  return out
}

function toWireTools(tools: ToolDef[]): WireTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
  } catch {}
  return {}
}

function isAbortError(err: any): boolean {
  return err?.name === "AbortError" || /abort/i.test(String(err?.message ?? err))
}

/** At most 3 attempts inside one generation (the first included); 4xx and user stops are never retried; request-level timeouts count as retryable network errors */
const MAX_ATTEMPTS = 3
const INTERRUPTED_TEXT = "Interrupted by user"
/** Backfill text for unfinished tools on stop/preempt (en-US; later turns' toWireMessages carry it to the model) */
const INTERRUPT_TOOL_ERROR = "user_cancelled: The user has interrupted this operation."

function isBound(entry: SessionEntry): boolean {
  return sessionKey(entry.projectId, entry.convId) === boundKey()
}

/** Whether this conversation is waiting on a human (pending card confirmation / pending form) — used by the input-bar gate and the preempt decision */
export function hasHumanWait(projectId: string, convId: string): boolean {
  return hasPendingFormFor(projectId, convId) || hasPendingWriteFor(projectId, convId)
}

/**
 * Preempt: the user sends a message while a turn waits on a human = cancel all pending forms/write confirmations of this conversation + abort its
 * current turn (wrapping up with stop semantics; unfinished tool parts get the user_cancelled text); the new message then forms an independent turn.
 * Returning false means the current turn is not in the "waiting on a human" state (network-streaming) or the old turn has not wrapped up; abandon this send.
 */
async function abandonWaitingTurn(entry: SessionEntry): Promise<boolean> {
  if (!hasHumanWait(entry.projectId, entry.convId)) return false
  entry.stopped = true
  const handle = turnHandle(entry.projectId, entry.convId)
  handle.abort?.abort()
  cancelFormsFor(entry.projectId, entry.convId)
  cancelWriteConfirmationsFor(entry.projectId, entry.convId)
  const start = Date.now()
  while (entry.streaming && Date.now() - start < 5000) {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 40))
  }
  return !entry.streaming
}

/** Stop the stream of a given conversation (keeps the already-generated part and marks it Interrupted by user); affects only that conversation, other parallel turns are untouched */
export function stopStreaming(projectId: string, convId: string) {
  const entry = getEntry(projectId, convId)
  if (!entry?.streaming) return
  entry.stopped = true
  turnHandle(projectId, convId).abort?.abort()
  cancelFormsFor(projectId, convId)
  cancelWriteConfirmationsFor(projectId, convId)
}

function isRetryableError(err: any): boolean {
  const status = typeof err?.status === "number" ? err.status : undefined
  if (status !== undefined) return status === 408 || status === 429 || status >= 500
  const msg = String(err?.message ?? err)
  if (err?.name === "AbortError" || /abort/i.test(msg)) return false
  // Network drop / empty stream / decode error / request-level timeout (LLMIdleTimeoutError): bounded retry allowed
  return true
}

/** Parse the picker's return value `${providerId}\u0001${model}` */
function parsePicked(value: string): { providerId: string; model: string } {
  const sep = value.indexOf("\u0001")
  if (sep === -1) return { providerId: value, model: "" }
  return { providerId: value.slice(0, sep), model: value.slice(sep + 1) }
}

/**
 * Persist the conversation-level model binding (sticky, written into Conversation metadata; resident entries go through the registry to prevent stale-copy overwrite),
 * while still updating project preferences as before (prefer_* as the default source for "unbound conversations").
 */
async function applyConversationBinding(entry: SessionEntry, providerId: string, model: string): Promise<void> {
  await updateConversationMeta(entry.projectId, entry.convId, { providerId, model })
  setProjectPreference(entry.projectId, { prefer_provider: providerId, prefer_model: model })
}

/**
 * Resolve the send target (provider, model) — conversation-level binding takes priority:
 * 1. conversation.providerId+model valid → use directly;
 * 2. binding missing (old conversation) → fall back to project preferences; the bound provider is no longer valid → treat as missing and go through the picker flow (Rule 10);
 * 3. either still missing → open the picker; the choice is written stickily into the conversation binding (and synced to project preferences).
 */
export async function resolveSendTarget(entry: SessionEntry): Promise<{ provider: LLMProvider; model: string } | null> {
  const projectId = entry.projectId
  const conv = entry.conversation
  const cfg = await loadConfig(projectId)

  const boundProvider = conv.providerId ? kProviderRegistry().getById(conv.providerId) : undefined
  let provider: LLMProvider | undefined = boundProvider
  if (!provider && !conv.providerId) {
    provider = cfg.spec.prefer_provider ? kProviderRegistry().getById(cfg.spec.prefer_provider) : undefined
  }

  if (!provider) {
    const providers = kProviderRegistry().getAll()
    if (providers.length === 0) {
      throw new Error("No Provider is configured yet. Please add one in Settings first.")
    }
    const picked = await openModelPicker({ purpose: "beforeSend", requireProvider: true })
    if (!picked) return null
    const { providerId, model } = parsePicked(picked)
    const p = kProviderRegistry().getById(providerId)
    if (!p) throw new Error("Selected Provider is no longer available")
    if (model) {
      await applyConversationBinding(entry, p.id, model)
      return { provider: p, model }
    }
    provider = p
  }

  const model = conv.model ?? (boundProvider ? undefined : cfg.spec.prefer_model)
  if (!model) {
    const picked = await chooseModel(provider)
    if (!picked) return null
    const parsed = parsePicked(picked)
    if (!parsed.model) return null
    const chosen = kProviderRegistry().getById(parsed.providerId) ?? provider
    await applyConversationBinding(entry, chosen.id, parsed.model)
    return { provider: chosen, model: parsed.model }
  }

  return { provider, model }
}

/** Model selection needed: flatten the full list (the picker fetches it when the cache is missing, falling back to manual input on failure) */
async function chooseModel(provider: LLMProvider): Promise<string | null> {
  return openModelPicker({ purpose: "beforeSend", provider })
}

/** modelBar/Models entry: manually switching the conversation model = sticky write into the conversation binding (also syncs the project-preference default); affects only the next turn, never interrupts a running one */
export async function setConversationModel(projectId: string, convId: string, providerId: string, model: string): Promise<void> {
  const entry = await ensureEntry(projectId, convId)
  await applyConversationBinding(entry, providerId, model)
}

/** Race with abort: stop and preempt also exit immediately during tool execution / confirmation waiting (the wait itself has no timeout) */
function withAbortRace<T>(p: Promise<T>, signal: AbortSignal): Promise<T | "aborted"> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve("aborted")
      return
    }
    const onAbort = () => resolve("aborted")
    signal.addEventListener("abort", onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort)
        resolve(v)
      },
      (err) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      }
    )
  })
}

/**
 * Run one assistant generation turn (streaming); all state is written on that conversation's entry.
 * messages is the complete history ending with the user msg; provider/model is resolved by resolveSendTarget (fixed within the turn —
 * switching the binding mid-turn does not affect this turn, it takes effect next turn).
 */
export async function runAssistantTurn(
  entry: SessionEntry,
  opts: {
    provider: LLMProvider
    model: string
    system?: string
    messages: ChatMessage[]
  }
): Promise<{ ok: boolean; stopped: boolean }> {
  const { provider, model, system } = opts
  const projectId = entry.projectId
  const convId = entry.convId
  if (entry.streaming) return { ok: false, stopped: false }

  const handle = turnHandle(projectId, convId)
  const abort = new AbortController()
  const myTurn = ++handle.seq
  handle.abort = abort

  entry.streaming = true
  entry.stopped = false
  entry.error = null

  const assistant: ChatMessage = {
    id: `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    role: "assistant",
    parts: [],
    createdAt: Date.now(),
    state: "streaming",
  }
  entry.messages = [...(entry.messages as ChatMessage[]), assistant]

  let lastFlush = 0
  // assistant is a raw object and stream mutations bypass the proxy; valtio caches snapshots by raw reference and
  // FlashList memos cells by item identity ⇒ swapping only the array without swapping references would never refresh the UI.
  // Every flush must replace the same-id message with a fresh clone to force a new identity.
  const cloneAssistant = (): ChatMessage => ({
    ...assistant,
    parts: assistant.parts.map((p) => ({ ...p })),
  })
  const replaceAssistant = (list: ChatMessage[]): ChatMessage[] =>
    list.map((m) => (m.id === assistant.id ? cloneAssistant() : m))
  const flushUI = () => {
    const now = Date.now()
    if (now - lastFlush >= 60) {
      lastFlush = now
      entry.messages = replaceAssistant(entry.messages as ChatMessage[])
      // Disk writes debounced 800ms (the old implementation persisted on every flush, 60ms was too frequent)
      schedulePersist(entry)
    }
  }

  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  // Tool parts are pushed into assistant.parts in arrival order (streaming and final order stay identical, preventing card position jumps when generation ends);
  // the map only holds references to those same objects; status/result mutate in place and cloneAssistant carries them out on each flush.
  const toolParts = new Map<string, MessagePartToolCall>()
  const ensureToolPart = (id: string, name: string): MessagePartToolCall => {
    let part = toolParts.get(id)
    if (!part) {
      part = {
        type: "tool_call",
        id,
        name: name as MessagePartToolCall["name"],
        args: {},
        status: "running",
      }
      toolParts.set(id, part)
      assistant.parts.push(part)
      flushUI()
    }
    return part
  }
  /** Stop/preempt wrap-up: stamp still-running tool parts with the interrupted text (later turns' toWireMessages need legal tool results); this conversation's leftover write confirmations are cleared as well */
  const markInterruptedTools = () => {
    cancelWriteConfirmationsFor(projectId, convId)
    for (const part of toolParts.values()) {
      if (part.status === "running") {
        part.status = "error"
        part.error = INTERRUPT_TOOL_ERROR
      }
    }
  }

  const appendStreamText = (kind: "text" | "reasoning", delta: string) => {
    const last = assistant.parts[assistant.parts.length - 1]
    if (last && last.type === kind) {
      last.text += delta
    } else {
      assistant.parts.push({ type: kind, text: delta })
    }
    flushUI()
  }

  const tools = buildTools(projectId)
  const wireTools = toWireTools(tools)
  const toolsByName = new Map<string, ToolDef>(tools.map((t) => [t.name, t] as const))

  /** A single attempt: the complete multi-step tool loop; failures/exceptions are thrown to the outer retry loop for classification */
  const consumeOnce = async (): Promise<"done" | "stopped"> => {
    const wire: WireMessage[] = [
      { role: "system", content: system?.trim() ? system : DEFAULT_SYSTEM_PROMPT },
      ...toWireMessages(opts.messages),
    ]

    for (let step = 0; step < MAX_STEPS; step++) {
      if (entry.stopped) return "stopped"

      const handlers: StreamHandlers = {
        onTextDelta: (t) => appendStreamText("text", t),
        onReasoningDelta: (t) => appendStreamText("reasoning", t),
        onToolCallStart: (call) => {
          ensureToolPart(call.id, call.name)
        },
        onToolCallArgs: () => {
          flushUI()
        },
      }

      let outcome
      try {
        // The request-level idle watchdog lives inside openai-client (resets on any bytes); stop = AbortError, silence = LLMIdleTimeoutError
        outcome = await streamChatCompletion({
          provider,
          model,
          messages: wire,
          tools: wireTools,
          handlers,
          signal: abort.signal,
        })
      } catch (err: any) {
        if (isAbortError(err) || entry.stopped) return "stopped"
        throw err
      }
      if (entry.stopped) return "stopped"

      const calls: AccumulatedToolCall[] = outcome.toolCalls
      if (calls.length === 0) {
        // No tool calls: the final answer of this turn. An empty stream is treated as a retryable error (bounded retry outside).
        const hasContent = assistant.parts.some(
          (p) => p.type === "text" || p.type === "reasoning" || p.type === "tool_call"
        )
        if (!hasContent) throw new Error("Empty response: the server ended the stream immediately without returning data")
        return "done"
      }

      // Backfill arguments, build assistant(wire), then execute each tool one by one and backfill results
      const assistantMsg: WireMessage = { role: "assistant", content: outcome.text || null, tool_calls: [] }
      for (const call of calls) {
        const part = ensureToolPart(call.id, call.name)
        part.args = parseToolArgs(call.args)
        assistantMsg.tool_calls!.push({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.args || "{}" },
        })
      }
      flushUI()
      wire.push(assistantMsg)

      for (const call of calls) {
        if (entry.stopped) return "stopped"
        const part = toolParts.get(call.id)!
        let resultContent: string
        const def = toolsByName.get(call.name)
        if (!def) {
          part.status = "error"
          part.error = `Unknown tool: ${call.name}`
          resultContent = JSON.stringify({ ok: false, error: part.error })
        } else {
          try {
            const raced = await withAbortRace(
              def.execute(part.args, { toolCallId: call.id, projectId, convId, signal: abort.signal }),
              abort.signal
            )
            if (raced === "aborted") {
              markInterruptedTools()
              flushUI()
              return "stopped"
            }
            const value = raced as { ok?: boolean; rejected?: boolean; error?: string }
            if (value.ok === false) {
              part.status = value.rejected ? "rejected" : "error"
              part.error = value.error ?? "Tool execution failed"
              resultContent = JSON.stringify(value)
            } else {
              part.status = "ok"
              part.result = JSON.stringify(value)
              resultContent = part.result
            }
          } catch (err: any) {
            part.status = "error"
            part.error = String(err?.message ?? err)
            resultContent = JSON.stringify({ ok: false, error: part.error })
          }
        }
        wire.push({ role: "tool", tool_call_id: call.id, content: resultContent })
        flushUI()
      }
    }

    // Step limit reached: the last response is already contained in parts, treated as done (matches the AI SDK stopWhen semantics)
    const hasContent = assistant.parts.some(
      (p) => p.type === "text" || p.type === "reasoning" || p.type === "tool_call"
    )
    if (!hasContent) throw new Error("Empty response: the server ended the stream immediately without returning data")
    return "done"
  }

  let finalKind: "done" | "stopped" | "error" = "done"
  let lastError: any = null
  let attemptsUsed = 0

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (entry.stopped) {
        finalKind = "stopped"
        break
      }
      attemptsUsed = attempt
      if (attempt > 1) {
        assistant.parts = []
        toolParts.clear()
        flushUI()
        await delay(300 * attempt)
        if (entry.stopped || myTurn !== handle.seq) {
          finalKind = "stopped"
          break
        }
      }
      try {
        finalKind = await consumeOnce()
        break
      } catch (err: any) {
        const msg = String(err?.message ?? err)
        console.log("[chat] attempt", attempt, "failed:", err?.name, msg)
        if (entry.stopped || isAbortError(err)) {
          finalKind = "stopped"
          break
        }
        lastError = err
        if (attempt >= MAX_ATTEMPTS || !isRetryableError(err)) {
          finalKind = "error"
          break
        }
      }
    }
  } catch (err: any) {
    lastError = err
    finalKind = "error"
  }

  // A stale turn (its generation number was superseded by a newer turn of the same conversation) must not overwrite conversation state; the new turn wraps up itself
  if (myTurn === handle.seq) {
    if (finalKind === "stopped") {
      markInterruptedTools()
    }
    if (finalKind === "error") {
      assistant.state = "error"
      const baseMsg = String(lastError?.message ?? lastError ?? "Generation failed")
      assistant.error = attemptsUsed > 1 ? `${baseMsg} (attempted ${attemptsUsed}/${MAX_ATTEMPTS} times)` : baseMsg
      entry.error = assistant.error
      entry.lastErrorAt = Date.now()
    } else if (finalKind === "stopped") {
      assistant.state = "stopped"
      assistant.error = INTERRUPTED_TEXT
    } else {
      assistant.state = "done"
    }
    entry.messages = replaceAssistant(entry.messages as ChatMessage[])
    await persistNow(entry)
    // If this conversation is still the bound one at turn wrap-up → mark read (the user is present); unbound keeps the previous value so the failure badge lights up naturally
    if (isBound(entry)) {
      touchLastRead(entry)
    }
  }
  if (myTurn === handle.seq) {
    entry.streaming = false
    entry.stopped = false
    if (handle.abort === abort) handle.abort = null
  }
  return { ok: finalKind === "done", stopped: finalKind === "stopped" || entry.stopped }
}

export interface PendingAttachment {
  name: string
  content: string
}

/** Send a user message (attachment content already read by the caller); only touches the given conversation, other parallel WIP conversations are unaffected */
export async function sendUserMessage(
  projectId: string,
  convId: string,
  text: string,
  attachments?: PendingAttachment[]
) {
  const entry = await ensureEntry(projectId, convId)
  if (entry.streaming) {
    if (!(await abandonWaitingTurn(entry))) return
  }

  const msg: ChatMessage = {
    id: `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    parts: [],
    createdAt: Date.now(),
    state: "done",
  }
  for (const att of attachments ?? []) {
    msg.parts.push({ type: "attachment", name: att.name, content: att.content })
  }
  if (text.trim()) msg.parts.push({ type: "text", text })
  if (msg.parts.length === 0) return

  entry.messages = [...(entry.messages as ChatMessage[]), msg]
  // Sending = explicit presence: mark read
  touchLastRead(entry)
  await persistNow(entry)

  const target = await resolveSendTarget(entry)
  if (!target) return
  const result = await runAssistantTurn(entry, {
    provider: target.provider,
    model: target.model,
    system: entry.conversation.systemPrompt || undefined,
    messages: entry.messages as ChatMessage[],
  })
  if (result.ok) {
    await maybeSummarizeConversation(entry, target.provider, target.model)
  }
}

/** Regenerate the answer to the last user message: trim to that message and rerun the whole turn (tool replay + write operations confirmed via cards again) */
export async function regenerateLastAssistant(projectId: string, convId: string) {
  const entry = await ensureEntry(projectId, convId)
  if (entry.streaming) {
    if (!(await abandonWaitingTurn(entry))) return
  }

  const msgs = [...(entry.messages as ChatMessage[])]
  let targetIndex = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      targetIndex = i
      break
    }
  }
  if (targetIndex === -1) return

  entry.messages = msgs.slice(0, targetIndex + 1)
  touchLastRead(entry)
  await persistNow(entry)

  const target = await resolveSendTarget(entry)
  if (!target) return
  const result = await runAssistantTurn(entry, {
    provider: target.provider,
    model: target.model,
    system: entry.conversation.systemPrompt || undefined,
    messages: entry.messages as ChatMessage[],
  })
  if (result.ok) {
    await maybeSummarizeConversation(entry, target.provider, target.model)
  }
}
