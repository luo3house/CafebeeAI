/**
 * evalflow: the `run_javascript` execution bridge (queue + slot accounting; the WebView itself lives in the hidden
 * host `ui/host/eval-host`, mounted under GlobalHosts so background turns can evaluate while any screen is on top).
 * FIFO queue with at most MAX_ACTIVE one-shot WebViews process-wide; queued calls simply wait and their tool cards
 * show "Running". The 10s wall clock starts when a slot opens and the WebView mounts (the runner arms it) - the queue
 * wait is not counted. Every settle path (result / error / timeout / stop / preempt) tears the WebView down by
 * unmounting its runner, and abort/cancel settle with the user_cancelled error like the other network-holding tools.
 */
import { proxy } from "valtio"

export type EvalOutcome = { ok: true; result: string; truncated?: boolean } | { ok: false; error: string }

export const EVAL_CANCELLED_ERROR = "user_cancelled: The user has interrupted this operation."
export const EVAL_TIMEOUT_ERROR = "Evaluation timed out after 10 seconds"

/** Process-wide concurrency cap (each slot is a mounted WebView); extra calls wait in FIFO order */
const MAX_ACTIVE = 3

interface EvalJob {
  id: string
  /** Frozen code snapshot (exactly what the approval confirmed) */
  code: string
  resolve: (outcome: EvalOutcome) => void
  cleanup: () => void
  settled: boolean
}

const jobs = new Map<string, EvalJob>()
const waiting: string[] = []

/** Reactive view for the hidden WebView host: toolCallIds currently holding an execution slot */
export const evalflow = proxy<{ activeIds: string[] }>({ activeIds: [] })

/** Raw lookup for the host (the code is immutable for the job's lifetime) */
export function getEvalJob(id: string): { code: string } | undefined {
  return jobs.get(id)
}

function pump(): void {
  while (evalflow.activeIds.length < MAX_ACTIVE && waiting.length > 0) {
    const id = waiting.shift()!
    const job = jobs.get(id)
    if (!job || job.settled) continue
    evalflow.activeIds = [...evalflow.activeIds, id]
  }
}

function settle(job: EvalJob, outcome: EvalOutcome): void {
  if (job.settled) return
  job.settled = true
  job.cleanup()
  const waitIdx = waiting.indexOf(job.id)
  if (waitIdx >= 0) waiting.splice(waitIdx, 1)
  const wasActive = evalflow.activeIds.indexOf(job.id) >= 0
  if (wasActive) evalflow.activeIds = evalflow.activeIds.filter((x) => x !== job.id)
  jobs.delete(job.id)
  if (wasActive) pump()
  job.resolve(outcome)
}

/**
 * Run one evaluation and deliver the outcome to the tool. The promise never rejects: the result is always a JSON
 * envelope ({ok:true, result, truncated?} / {ok:false, error}). The abort signal (stop/preempt) tears the job down
 * mid-queue or mid-run with the user_cancelled error.
 */
export function requestEval(toolCallId: string, code: string, signal?: AbortSignal): Promise<EvalOutcome> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: EVAL_CANCELLED_ERROR })
      return
    }
    const existing = jobs.get(toolCallId)
    if (existing) settle(existing, { ok: false, error: EVAL_CANCELLED_ERROR })
    const onAbort = () => {
      const job = jobs.get(toolCallId)
      if (job) settle(job, { ok: false, error: EVAL_CANCELLED_ERROR })
    }
    const job: EvalJob = {
      id: toolCallId,
      code,
      resolve,
      settled: false,
      cleanup: () => signal?.removeEventListener("abort", onAbort),
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    jobs.set(toolCallId, job)
    waiting.push(toolCallId)
    pump()
  })
}

/** The hidden runner settles the run (result / error / timeout): release the slot and hand the outcome to the tool */
export function finishEval(toolCallId: string, outcome: EvalOutcome): void {
  const job = jobs.get(toolCallId)
  if (!job) return
  settle(job, outcome)
}
