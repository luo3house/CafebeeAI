/**
 * Hand-written OpenAI Compatible client (replaces the Vercel AI SDK, zero dependencies):
 * - RN's `fetch` has no streaming response body → SSE uses `XMLHttpRequest` to read `responseText`
 *   incrementally (`slice(processed)` once readyState>=3).
 * - Hand-written SSE line parsing: `data:` prefix, `[DONE]` sentinel, comment/keep-alive lines ignored.
 *   responseText is already a decoded string; no TextDecoder/ReadableStream/any polyfill is needed.
 * - Request headers aligned with the POC (main_fetch_chat_completions.js): send only
 *   content-type / authorization / user-defined headers; never accept / user-agent /
 *   cache-control / x-requested-with (some gateways reject based on them).
 * - No react-native-sse: it hardcodes internal headers, auto-reconnects every 5s after DONE (duplicate POSTs),
 *   and never dispatches close on a normal finish.
 * - tool_calls deltas are aggregated by index (id/name arrive first, arguments concatenated piece by piece);
 *   once aggregated they reach the upper agent loop via the onToolCallStart callback + outcome.toolCalls.
 * - **Timeouts only bite requests, never the flow**: idleTimeoutMs is a "network-silence detector" (resets whenever bytes arrive);
 *   when it fires it throws LLMIdleTimeoutError (classified upstream as a retryable network error);
 *   tool execution / card confirmation / form waits on a human are outside the request and naturally have no timeouts.
 */
import type { LLMProvider } from "../core/providers"
import { kSecretStore } from "../core/secrets"

/** Default request-level network-silence threshold: 120s without any data */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000

export interface WireToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

export interface WireTool {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface AccumulatedToolCall {
  index: number
  id: string
  name: string
  args: string
}

export interface StreamHandlers {
  onTextDelta?: (delta: string) => void
  onReasoningDelta?: (delta: string) => void
  /** Both id and name have arrived (arguments may still be streaming in) */
  onToolCallStart?: (call: AccumulatedToolCall) => void
  onToolCallArgs?: (index: number, delta: string) => void
}

export interface StreamRequest {
  provider: LLMProvider
  model: string
  messages: WireMessage[]
  tools?: WireTool[]
  signal: AbortSignal
  handlers?: StreamHandlers
  /** Network-silence threshold (ms, default 120s): a continuous stretch without any bytes triggers LLMIdleTimeoutError */
  idleTimeoutMs?: number
}

export interface StreamOutcome {
  text: string
  reasoning: string
  toolCalls: AccumulatedToolCall[]
  finishReason: string | null
  /** Number of chunks parsed successfully; 0 usually means the server ended the stream immediately */
  chunkCount: number
  sawDone: boolean
}

export class LLMHttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "LLMHttpError"
    this.status = status
  }
}

export class LLMNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LLMNetworkError"
  }
}

/** Request-level network-silence timeout (distinct from the user-stop AbortError; handled upstream as a retryable network error) */
export class LLMIdleTimeoutError extends Error {
  constructor(seconds: number) {
    super(`Request timed out: no response data after ${seconds}s`)
    this.name = "LLMIdleTimeoutError"
  }
}

function abortError(): Error {
  const e = new Error("Request aborted")
  e.name = "AbortError"
  return e
}

/** Extract a human-readable message from an OpenAI-style error response body */
function extractErrorMessage(bodyText: string): string {
  const fallback = bodyText.slice(0, 300) || "Unknown server error"
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: unknown }; message?: unknown }
    const m = parsed?.error?.message ?? parsed?.message
    return typeof m === "string" && m ? m : fallback
  } catch {
    return fallback
  }
}

interface Accumulator {
  text: string
  reasoning: string
  finishReason: string | null
  chunkCount: number
  sawDone: boolean
  calls: Map<number, AccumulatedToolCall>
  started: Set<number>
}

function processChunk(raw: string, acc: Accumulator, handlers?: StreamHandlers): void {
  let chunk: unknown
  try {
    chunk = JSON.parse(raw)
  } catch {
    return // non-JSON line (keep-alive/partial), ignored
  }
  const parsed = chunk as {
    choices?: {
      delta?: {
        content?: unknown
        reasoning_content?: unknown
        reasoning?: unknown
        tool_calls?: { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }[]
      } | null
      finish_reason?: unknown
    }[]
  }
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined
  if (!choice) return
  const delta = choice.delta ?? {}

  if (typeof delta.content === "string" && delta.content) {
    acc.text += delta.content
    handlers?.onTextDelta?.(delta.content)
  }
  const reasoningDelta =
    typeof delta.reasoning_content === "string"
      ? delta.reasoning_content
      : typeof delta.reasoning === "string"
        ? delta.reasoning
        : ""
  if (reasoningDelta) {
    acc.reasoning += reasoningDelta
    handlers?.onReasoningDelta?.(reasoningDelta)
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const index = typeof tc?.index === "number" ? tc.index : 0
      let call = acc.calls.get(index)
      if (!call) {
        call = { index, id: "", name: "", args: "" }
        acc.calls.set(index, call)
      }
      if (typeof tc?.id === "string" && tc.id) call.id = tc.id
      if (typeof tc?.function?.name === "string") call.name += tc.function.name
      if (typeof tc?.function?.arguments === "string" && tc.function.arguments) {
        call.args += tc.function.arguments
        handlers?.onToolCallArgs?.(index, tc.function.arguments)
      }
      if (call.id && call.name && !acc.started.has(index)) {
        acc.started.add(index)
        handlers?.onToolCallStart?.({ ...call })
      }
    }
  }
  if (typeof choice.finish_reason === "string") acc.finishReason = choice.finish_reason
}

/** Feed text incrementally, parse SSE line by line, return the unfinished line-tail cache */
function feedSSE(pending: string, text: string, onPayload: (data: string) => void): string {
  const lines = (pending + text).split("\n")
  const rest = lines.pop() ?? ""
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) continue
    const payload = trimmed.slice(5).trim()
    if (payload) onPayload(payload)
  }
  return rest
}

export function streamChatCompletion(req: StreamRequest): Promise<StreamOutcome> {
  return new Promise<StreamOutcome>((resolve, reject) => {
    const acc: Accumulator = {
      text: "",
      reasoning: "",
      finishReason: null,
      chunkCount: 0,
      sawDone: false,
      calls: new Map(),
      started: new Set(),
    }
    const payload: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
    }
    if (req.tools && req.tools.length > 0) payload.tools = req.tools
    const body = JSON.stringify(payload)
    const headers = kSecretStore().buildHeaders(req.provider)
    const url = `${req.provider.baseURL.replace(/\/+$/, "")}/chat/completions`

    let processed = 0
    let lineRest = ""
    let opened = false
    let settled = false
    let xhr: XMLHttpRequest

    const idleMs = req.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }
    /** Reset whenever bytes arrive: the watchdog only bites "a request with no data", never the flow (tool/confirmation/form waits are naturally timeout-free) */
    const resetIdle = () => {
      if (settled || idleMs <= 0) return
      clearIdle()
      idleTimer = setTimeout(() => {
        // fail first (once settled, every event fired by xhr.abort is swallowed), then cut the transport
        fail(new LLMIdleTimeoutError(Math.round(idleMs / 1000)))
        try {
          xhr.abort()
        } catch {}
      }, idleMs)
    }

    const onPayload = (data: string) => {
      if (data === "[DONE]") {
        acc.sawDone = true
        return
      }
      acc.chunkCount++
      processChunk(data, acc, req.handlers)
    }
    const pump = () => {
      const text: string = xhr.responseText ?? ""
      if (text.length > processed) {
        const chunk = text.slice(processed)
        processed = text.length
        lineRest = feedSSE(lineRest, chunk, onPayload)
        resetIdle()
      }
    }
    const finish = () => {
      if (settled) return
      settled = true
      clearIdle()
      resolve({
        text: acc.text,
        reasoning: acc.reasoning,
        finishReason: acc.finishReason,
        chunkCount: acc.chunkCount,
        sawDone: acc.sawDone,
        toolCalls: [...acc.calls.values()].sort((a, b) => a.index - b.index),
      })
    }
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      clearIdle()
      reject(err)
    }

    xhr = new XMLHttpRequest()
    xhr.open("POST", url, true)
    for (const [k, v] of Object.entries(headers)) {
      try {
        xhr.setRequestHeader(k, v)
      } catch {}
    }
    xhr.timeout = 0

    xhr.onreadystatechange = () => {
      if (settled) return
      const status = xhr.status
      if (!opened && status >= 200 && status < 300) opened = true
      if (opened && xhr.readyState >= 3) pump()
      if (xhr.readyState === 4) {
        if (status >= 200 && status < 300) {
          pump()
          finish()
        } else if (status > 0) {
          fail(new LLMHttpError(status, `HTTP ${status}: ${extractErrorMessage(xhr.responseText ?? "")}`))
        } else {
          fail(new LLMNetworkError("Network error: connection failed or request interrupted"))
        }
      }
    }
    xhr.onerror = () => fail(new LLMNetworkError("Network error: request failed (xhr onerror)"))
    xhr.ontimeout = () => fail(new LLMNetworkError("Network error: request timed out"))

    const onAbort = () => {
      try {
        xhr.abort()
      } catch {}
      fail(abortError())
    }
    if (req.signal.aborted) {
      onAbort()
      return
    }
    req.signal.addEventListener("abort", onAbort, { once: true })

    try {
      xhr.send(body)
      resetIdle()
    } catch (err: any) {
      fail(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/** Non-streaming JSON POST (title summarization / test calls; the models list uses the fetch in providers.ts). Has a request-level timeout. */
export async function postJSON<T = unknown>(
  provider: LLMProvider,
  path: string,
  payload: unknown,
  timeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS
): Promise<T> {
  const headers = kSecretStore().buildHeaders(provider)
  const work = (async () => {
    const res = await fetch(`${provider.baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    })
    const text = await res.text()
    if (!res.ok) throw new LLMHttpError(res.status, `HTTP ${res.status}: ${extractErrorMessage(text)}`)
    try {
      return JSON.parse(text) as T
    } catch {
      throw new LLMNetworkError("Response is not valid JSON")
    }
  })()
  if (timeoutMs <= 0) return work
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LLMIdleTimeoutError(Math.round(timeoutMs / 1000))), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
