/**
 * formflow: the `show_form` user-form bridge. valtio pending queue + resolver (same shape as toolflow),
 * plus collapsed drafts (field snapshots for non-file forms, restored when the form reopens).
 * Submit results / error text sent back to the model are always en-US (Rule 14).
 */
import { proxy } from "valtio"
import Config from "react-native-config"
import { notifyHumanWait } from "./notifications"

/** Window-property prefix of the injected form bridge (dotenv `TOOL_CALL_FORM_BRIDGE_PREFIX`, Rule 32); the literal is the no-config fallback */
export const FORM_BRIDGE_PREFIX = Config.TOOL_CALL_FORM_BRIDGE_PREFIX || "__cafebeeai"

export interface PendingForm {
  /** The part.id of the corresponding tool_call; the hub card matches on this */
  toolCallId: string
  /** Owning conversation (multi-session parallelism WIP: cancellations/badges are scoped by this, never cross-talking) */
  projectId: string
  convId: string
  title: string
  /** Raw HTML before preprocessing (the form screen handles the template wrapping/injection) */
  html: string
  hasFileInput: boolean
  sizeBytes: number
  createdAt: number
}

/** Field-snapshot record (produced by the injected `${FORM_BRIDGE_PREFIX}_snapshot`, in control appearance order) */
export interface FormDraftEntry {
  /** `name\u0000type` */
  k: string
  v: unknown
  c: boolean
}

export type FormDraft = FormDraftEntry[]

export interface FormSubmitPayload {
  fields: Record<string, unknown>
  submitter: string
}

export type FormToolResult =
  | { ok: true; fields: Record<string, unknown>; submitter: string }
  | { ok: false; error: string; rejected?: boolean }

type Resolver = (result: FormToolResult) => void

interface FormflowState {
  pending: PendingForm[]
  resolvers: Record<string, Resolver>
  drafts: Record<string, FormDraft>
  /** Document-size memory (toolCallId → bytes): lets the card badge still show after the form settles */
  sizes: Record<string, number>
}

export const formflow = proxy<FormflowState>({
  pending: [],
  resolvers: {},
  drafts: {},
  sizes: {},
})

export function requestForm(req: Omit<PendingForm, "createdAt">): Promise<FormToolResult> {
  return new Promise((resolve) => {
    const item: PendingForm = { ...req, createdAt: Date.now() }
    formflow.pending.push(item)
    formflow.resolvers[item.toolCallId] = resolve
    formflow.sizes[item.toolCallId] = item.sizeBytes
    // Background-only "Needs attention" notification (no-op when foreground or notifications are off)
    notifyHumanWait(item.projectId, item.convId)
  })
}

function settle(toolCallId: string, result: FormToolResult, keepDraft: boolean): void {
  const resolver = formflow.resolvers[toolCallId]
  formflow.pending = formflow.pending.filter((p) => p.toolCallId !== toolCallId)
  delete formflow.resolvers[toolCallId]
  if (!keepDraft) delete formflow.drafts[toolCallId]
  resolver?.(result)
}

/** The user submitted the form successfully (the caller performs the content size-cap check beforehand) */
export function resolveFormSuccess(toolCallId: string, payload: FormSubmitPayload): void {
  settle(toolCallId, { ok: true, fields: payload.fields, submitter: payload.submitter }, false)
}

/** Explicit "Reject" / "Discard form": rejected flag + user_rejected, the model's current turn continues */
export function rejectForm(toolCallId: string): void {
  settle(
    toolCallId,
    { ok: false, rejected: true, error: "user_rejected: The user declined to fill out the form." },
    false
  )
}

/** Generic failure result (render_failed / payload_too_large etc.) */
export function failForm(toolCallId: string, error: string): void {
  settle(toolCallId, { ok: false, error }, false)
}

/** Interrupted (preempted by a new message / the stop button): user_cancelled */
export function cancelForm(toolCallId: string): void {
  settle(toolCallId, { ok: false, error: "user_cancelled: The user has interrupted this operation." }, false)
}

/** Whether this conversation has a pending form to fill (used by the input bar / badges / preempt decision) */
export function hasPendingFormFor(projectId: string, convId: string): boolean {
  return formflow.pending.some((p) => p.projectId === projectId && p.convId === convId)
}

/** Preempt/stop: cancels only this conversation's pending forms (other parallel conversations unaffected); returns the count cancelled */
export function cancelFormsFor(projectId: string, convId: string): number {
  const ids = formflow.pending
    .filter((p) => p.projectId === projectId && p.convId === convId)
    .map((p) => p.toolCallId)
  for (const id of ids) cancelForm(id)
  return ids.length
}

/** Save the field snapshot when collapsing the form page (forms with a file input are not saved, reopen = fresh form) */
export function saveDraft(toolCallId: string, draft: FormDraft): void {
  formflow.drafts[toolCallId] = draft
}
