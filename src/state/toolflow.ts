/**
 * toolflow: the `write_file` / `edit_file` / `download_file` user-confirmation bridge (inline in the tool_call card, no dialog).
 * Two-layer approval (highest priority first):
 *   1. App-level auto-approve switch (settings.autoApproveWrites) → short-circuit pass, never queued;
 *   2. Per-card confirmation (default): the pending queue matches by toolCallId to the owning tool card, which shows
 *      approve/reject ([Reject][Approve] write/edit, [Reject][Open][Approve] download; Open is inspection-only).
 * A pending item is the "awaiting confirmation" state itself (same shape as formflow; tool cards query the queue by toolCallId to render buttons);
 * "don't ask again in this session" and WriteToolScope were removed along with the dialog.
 * Download-only transient channel: `progress` (toolCallId → bytes) is fed by the blob-util stream progress handler while a
 * download runs; in-memory display only (never persisted, cleared when the tool settles), read by the card only at Running.
 * Stop/preempt/abort wrap-up clears only this conversation's pending items (cancelWriteConfirmationsFor), leaving other parallel conversations untouched.
 */
import { proxy } from "valtio"
import { settings } from "./settings"
import { notifyHumanWait } from "./notifications"
import type { ToolCallKind } from "../core/chats"

export type WriteToolName = "write_file" | "edit_file" | "download_file"

export interface PendingWriteConfirmation {
  id: string
  /** Tool cards match on this (= tool_call part.id); the unique identifier of the awaiting-confirmation state */
  toolCallId: string
  tool: WriteToolName
  projectId: string
  convId: string
  path: string
  /** write_file: full content; edit_file: new_string; download_file: none (the file is only fetched after approval) */
  content?: string
  /** edit_file: old_string */
  oldContent?: string
  /** download_file: source URL (the Open button and the preview show it) */
  url?: string
  overwrite: boolean
  createdAt: number
}

/** download_file transfer progress (toolCallId → bytes); total = 0 means the server sent no usable Content-Length */
export interface DownloadProgress {
  received: number
  total: number
}

type Resolver = (approved: boolean) => void

interface ToolflowState {
  pending: PendingWriteConfirmation[]
  resolvers: Record<string, Resolver>
  progress: Record<string, DownloadProgress>
}

export const toolflow = proxy<ToolflowState>({
  pending: [],
  resolvers: {},
  progress: {},
})

function requestConfirmation(req: Omit<PendingWriteConfirmation, "id" | "createdAt">): Promise<boolean> {
  if (settings.autoApproveWrites) return Promise.resolve(true)
  return new Promise((resolve) => {
    const item: PendingWriteConfirmation = {
      ...req,
      id: `wf_${Math.random().toString(36).slice(2)}`,
      createdAt: Date.now(),
    }
    toolflow.pending.push(item)
    toolflow.resolvers[item.id] = resolve
    // Background-only "Needs attention" notification (no-op when foreground or notifications are off)
    notifyHumanWait(item.projectId, item.convId)
  })
}

export function requestWriteConfirmation(
  req: Omit<PendingWriteConfirmation, "id" | "createdAt">
): Promise<boolean> {
  return requestConfirmation(req)
}

/** Same bridge as write confirmation (auto-approve governs it too); the card renders [Reject][Open][Approve] for it */
export function requestDownloadConfirmation(
  req: Omit<PendingWriteConfirmation, "id" | "createdAt" | "content" | "oldContent"> & { tool: "download_file"; url: string }
): Promise<boolean> {
  return requestConfirmation(req)
}

export function resolveWriteConfirmation(id: string, approved: boolean): void {
  const resolver = toolflow.resolvers[id]
  toolflow.pending = toolflow.pending.filter((p) => p.id !== id)
  delete toolflow.resolvers[id]
  resolver?.(approved)
}

export function setDownloadProgress(toolCallId: string, received: number, total: number): void {
  toolflow.progress[toolCallId] = { received, total }
}

export function clearDownloadProgress(toolCallId: string): void {
  delete toolflow.progress[toolCallId]
}

/** Whether this conversation has a pending write/download confirmation (used by the input bar / badges) */
export function hasPendingWriteFor(projectId: string, convId: string, kind?: ToolCallKind): boolean {
  return toolflow.pending.some((p) => p.projectId === projectId && p.convId === convId && (!kind || p.tool === kind))
}

/** Stop/preempt/wrap-up: clears only this conversation's leftover pending items, resolving them as rejected (idempotent, other parallel conversations unaffected) */
export function cancelWriteConfirmationsFor(projectId: string, convId: string): void {
  const keep: PendingWriteConfirmation[] = []
  for (const item of toolflow.pending) {
    if (item.projectId === projectId && item.convId === convId) {
      const resolver = toolflow.resolvers[item.id]
      delete toolflow.resolvers[item.id]
      resolver?.(false)
    } else {
      keep.push(item)
    }
  }
  toolflow.pending = keep
}
