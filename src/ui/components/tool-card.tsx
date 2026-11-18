/**
 * Tool-call card: name/status/args/result each take exactly one line, overlong content is truncated without expanding (line height locked by global font size).
 * Three "hub card" exceptions (while waiting on a human the card itself is the confirmation/action entry, no popup):
 * - write_file / edit_file: a toolflow pending hit by toolCallId → inline [Reject][Approve] TagButton pills + tapping the card opens a read-only preview
 *   (path / overwrite warning / content or old-new contrast); the buttons appear only on the **newest record** (interactive);
 *   once resolved the card collapses back to one read-only line; stop/preempt finalization lands on "Cancelled".
 * - download_file: same hub shape with [Reject][Open][Approve] (Open sits BETWEEN Reject and Approve and is inspection-only -
 *   it shows the "Open external URL" ConfirmDialog and then Linking.openURL, never approving or rejecting; the card stays Pending);
 *   its body tap is the unified ToolDetail screen like every other card (pending state carries an approvalNote there:
 *   the overwrite warning + "The file is downloaded after approval." - no content detail exists because the fetch only
 *   happens once approved); while Running the card carries one progress line `done / total` (total "?" when unknown).
 *   At Done the indicator shows the downloaded size (icon unchanged).
 * - show_form: while suspended = same hub form as the write card: status (icon + "Pending") on the title row, a "Source: inline | <path>" detail row,
 *   [Reject][Open] TagButton pills below.
 *   The model-supplied `title` arg is never rendered on the card (it would unbalance the title row); it surfaces only as the FormFull Appbar header.
 * Unified across ALL cards: the status indicator (icon + label) always sits on the **right of the title row**;
 * the label vocabulary is fixed with no detail suffixes - Pending (awaiting approval) / Running (incl. tool calls queued for execution) /
 * Done / Failed / Rejected / Cancelled; a submitted form is just Done. Exception: write_file/edit_file at Done shows the changed line count
 * (icon unchanged); Result lines render without parenthetical details (stripped in display, they duplicate the indicator).
 * approval action buttons go left-to-right **Reject first, affirmative (Approve/Open) second**; the affirmative button is always the
 * theme-toned primaryContainer pill (never error red, even for overwrite); "rejected" shows close-circle-outline in error color (the old hand icon is gone).
 * debugWritePending = debug-page display override: does not read the real queue, buttons are not wired to real actions;
 * debugDownloadPending / debugDownloadProgress do the same for the download card (its Open button still shows the real confirm dialog - display-safe).
 * Tapping any card's title row opens the full-screen `ToolDetail` page (markdown: Indicator / Tool call / Input args / Output / Error).
 * Sole exception: the pending-confirmation write hub card keeps its body-tap read-only preview dialog (part of the approval flow);
 * the pending download hub card instead taps into the ToolDetail screen (with the approvalNote) - the unified detail behavior.
 */
import React, { useState } from "react"
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native"
import { useNavigation } from "@react-navigation/native"
import { Icon, Text as PaperText, useTheme, type MD3Theme } from "react-native-paper"
import { DialogButton } from "./dialog-button"
import { useSnapshot } from "valtio"
import { fs } from "../../app/app.ui.theme"
import type { MessagePartToolCall } from "../../core/chats"
import { formflow, rejectForm } from "../../state/formflow"
import { toolflow, resolveWriteConfirmation, type WriteToolName } from "../../state/toolflow"
import { showNotice } from "../../state/notice"
import { formatBytes, utf8ByteLength } from "../../llm/form-doc"
import { AppDialog } from "./app-dialog"
import { AppPressable } from "./app-pressable"
import { ConfirmDialog } from "./confirm-dialog"
import { dialogCompact } from "./dialog-compact"
import { TagButton } from "./tag-button"

/** Card text styles (13/18 name, 12/18 status, 12/16 line) scaled by the app-wide font size setting */
const cardFonts = (theme: MD3Theme) => ({
  name: { fontSize: fs(theme, 13), lineHeight: fs(theme, 18), fontWeight: "600" as const, flexShrink: 1 },
  status: { fontSize: fs(theme, 12), lineHeight: fs(theme, 18) },
  line: { fontSize: fs(theme, 12), lineHeight: fs(theme, 16), marginTop: 2 },
})

export const NAME_LABEL: Record<MessagePartToolCall["name"], string> = {
  read_file: "Read file",
  write_file: "Write file",
  list_files: "List files",
  search_files: "Search files",
  edit_file: "Edit file",
  download_file: "Download file",
  show_form: "Show form",
}

const STATUS_META: Record<NonNullable<MessagePartToolCall["status"]>, { icon: string; label: string }> = {
  ok: { icon: "check-circle-outline", label: "Done" },
  error: { icon: "close-circle-outline", label: "Failed" },
  rejected: { icon: "close-circle-outline", label: "Rejected" },
  running: { icon: "progress-clock", label: "Running" },
}

/** Awaiting-confirmation state (never persisted, derived from a toolflow pending hit) */
const AWAITING_META = { icon: "bell-ring-outline", label: "Pending" }

export interface ToolCardDebugWritePending {
  id?: string
  tool: WriteToolName
  path: string
  content: string
  oldContent?: string
  overwrite: boolean
}

export interface ToolCardDebugDownloadPending {
  path: string
  url: string
  overwrite: boolean
}

export interface ToolCardDebugDownloadProgress {
  received: number
  total?: number
}

export function ToolCard({
  part,
  interactive = true,
  debugWritePending,
  debugDownloadPending,
  debugDownloadProgress,
}: {
  part: MessagePartToolCall
  /** Whether the message holding this card is the newest record: action buttons show only on the pending card of the newest record */
  interactive?: boolean
  debugWritePending?: ToolCardDebugWritePending
  debugDownloadPending?: ToolCardDebugDownloadPending
  debugDownloadProgress?: ToolCardDebugDownloadProgress
}) {
  const theme = useTheme()
  const navigation = useNavigation<any>()
  const openDetail = (indicator: string) => navigation.navigate("ToolDetail", { part, indicator })

  if (part.name === "show_form") return <FormToolCard part={part} interactive={interactive} />

  if (part.name === "download_file") {
    return <DownloadToolCard part={part} interactive={interactive} debugPending={debugDownloadPending} debugProgress={debugDownloadProgress} />
  }

  if (part.name === "write_file" || part.name === "edit_file") {
    return <WriteToolCard part={part} interactive={interactive} debugPending={debugWritePending} />
  }

  // Status colors follow semantics rather than accent colors: done/running use neutral text colors (the icon already conveys the meaning), only failed and rejected use error;
  // never primary/tertiary (harsh dark blue under light themes, and tertiary leans purple under dark themes)
  const statusColor = part.status === "error" || part.status === "rejected" ? theme.colors.error : theme.colors.onSurfaceVariant

  const argsText =
    Object.entries(part.args)
      .filter(([k]) => k !== "content" && k !== "old_string" && k !== "new_string")
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(", ") || "(no args)"

  const statusMeta = STATUS_META[part.status ?? "running"]
  const statusText = isCancelledError(part) ? "Cancelled" : statusMeta.label

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surfaceVariant }]}>
      <AppPressable onPress={() => openDetail(statusText)}>
        <View style={styles.titleRow}>
          <View style={styles.metaRow}>
            <Icon source="cog-outline" size={14} color={theme.colors.onSurfaceVariant} />
            <Text style={[cardFonts(theme).name, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
              {NAME_LABEL[part.name] ?? part.name}
            </Text>
          </View>
          <View style={styles.metaRow}>
            <Icon source={statusMeta.icon} size={14} color={statusColor} />
            <Text style={[cardFonts(theme).status, { color: statusColor }]}>{statusText}</Text>
          </View>
        </View>
      </AppPressable>
      <Text style={[cardFonts(theme).line, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
        Target: {argsText}
      </Text>
      {part.result ? (
        <Text style={[cardFonts(theme).line, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
          Result: {stripParenthetical(part.result)}
        </Text>
      ) : null}
      {part.error ? (
        <Text style={[cardFonts(theme).line, { color: theme.colors.error }]} numberOfLines={1}>
          Error: {part.error}
        </Text>
      ) : null}
    </View>
  )
}

const isCancelledError = (part: MessagePartToolCall): boolean => part.status === "error" && (part.error ?? "").startsWith("user_cancelled")

/** Result rows never show parenthetical details (the write/edit indicator already carries the count) */
function stripParenthetical(text: string): string {
  return text.replace(/\s*\([^)]*\)/g, "").trim()
}

/** write_file/edit_file success indicator text = changed line count (icon stays the Done icon); null = fall back to "Done" */
function changedLinesLabel(part: MessagePartToolCall): string | null {
  const raw =
    part.name === "edit_file" ? (typeof part.args.new_string === "string" ? part.args.new_string : null) : typeof part.args.content === "string" ? part.args.content : null
  if (raw === null) return null
  const n = raw.replace(/\n+$/, "").split("\n").length
  return n > 0 ? `${n} line${n === 1 ? "" : "s"}` : null
}

const PREVIEW_MAX_LINES = 8

function PreviewBlock({ label, text }: { label: string; text: string }) {
  const theme = useTheme()
  const lines = text.split("\n")
  const omitted = lines.length > PREVIEW_MAX_LINES ? lines.length - PREVIEW_MAX_LINES : 0
  return (
    <View style={{ marginBottom: 8 }}>
      <PaperText variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 4 }}>
        {label}
      </PaperText>
      <View style={styles.previewBox}>
        <PaperText variant="bodySmall" style={{ color: theme.colors.onSurface }} numberOfLines={PREVIEW_MAX_LINES}>
          {text}
        </PaperText>
      </View>
      {omitted > 0 ? (
        <PaperText variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
          {omitted} more lines
        </PaperText>
      ) : null}
    </View>
  )
}

function WriteToolCard({ part, interactive, debugPending }: { part: MessagePartToolCall; interactive: boolean; debugPending?: ToolCardDebugWritePending }) {
  const theme = useTheme()
  const navigation = useNavigation<any>()
  const flowSnap = useSnapshot(toolflow)
  const [preview, setPreview] = useState(false)
  const openDetail = (indicator: string) => navigation.navigate("ToolDetail", { part, indicator })
  const realPending = flowSnap.pending.find((p) => p.toolCallId === part.id && p.tool !== "download_file")
  const pending = realPending ?? debugPending
  const isDebug = !realPending && !!debugPending

  // Awaiting confirmation: the title + target rows form the "tap for read-only preview" touch area, buttons stand independently outside (prevents double event delivery), shown only on the newest record
  if (pending && interactive) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.surfaceVariant }]}>
        <AppPressable onPress={() => setPreview(true)}>
          <View style={styles.titleRow}>
            <View style={styles.metaRow}>
              <Icon source="cog-outline" size={14} color={theme.colors.onSurfaceVariant} />
              <Text style={[cardFonts(theme).name, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
                {NAME_LABEL[part.name]}
              </Text>
            </View>
            <View style={styles.metaRow}>
              <Icon source={AWAITING_META.icon} size={14} color={theme.colors.onSurfaceVariant} />
              <Text style={[cardFonts(theme).status, { color: theme.colors.onSurfaceVariant }]}>{AWAITING_META.label}</Text>
            </View>
          </View>
          <Text style={[cardFonts(theme).line, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
            Target: {pending.path}
          </Text>
        </AppPressable>
        <View style={styles.btnRow}>
          <TagButton
            label="Reject"
            tone="danger"
            onPress={() => {
              if (isDebug || !realPending) return
              resolveWriteConfirmation(realPending.id, false)
            }}
          />
          <TagButton
            label="Approve"
            onPress={() => {
              if (isDebug || !realPending) return
              resolveWriteConfirmation(realPending.id, true)
            }}
          />
        </View>
        <WritePreviewDialog visible={preview} onClose={() => setPreview(false)} pending={pending} />
      </View>
    )
  }

  // Awaiting confirmation but not on the newest record (theoretically should not happen): no buttons, keep only the status row
  if (pending) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.surfaceVariant }]}>
        <AppPressable onPress={() => openDetail(AWAITING_META.label)}>
          <View style={styles.titleRow}>
            <View style={styles.metaRow}>
              <Icon source="cog-outline" size={14} color={theme.colors.onSurfaceVariant} />
              <Text style={[cardFonts(theme).name, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
                {NAME_LABEL[part.name]}
              </Text>
            </View>
            <View style={styles.metaRow}>
              <Icon source={AWAITING_META.icon} size={14} color={theme.colors.onSurfaceVariant} />
              <Text style={[cardFonts(theme).status, { color: theme.colors.onSurfaceVariant }]}>{AWAITING_META.label}</Text>
            </View>
          </View>
        </AppPressable>
        <Text style={[cardFonts(theme).line, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
          Target: {pending.path}
        </Text>
      </View>
    )
  }

  // Terminal state: the ordinary one-line tool card; user_cancelled-class errors display "Cancelled";
  // a successful write/edit carries the changed line count as the indicator text instead of "Done" (icon unchanged)
  const statusColor = part.status === "error" || part.status === "rejected" ? theme.colors.error : theme.colors.onSurfaceVariant
  const statusMeta = part.status ? STATUS_META[part.status] : STATUS_META.running
  const statusText = isCancelledError(part) ? "Cancelled" : part.status === "ok" ? changedLinesLabel(part) ?? statusMeta.label : statusMeta.label
  const pathArg = typeof part.args.path === "string" ? part.args.path : ""

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surfaceVariant }]}>
      <AppPressable onPress={() => openDetail(statusText)}>
        <View style={styles.titleRow}>
          <View style={styles.metaRow}>
            <Icon source="cog-outline" size={14} color={theme.colors.onSurfaceVariant} />
            <Text style={[cardFonts(theme).name, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
              {NAME_LABEL[part.name]}
            </Text>
          </View>
          <View style={styles.metaRow}>
            <Icon source={statusMeta.icon} size={14} color={statusColor} />
            <Text style={[cardFonts(theme).status, { color: statusColor }]}>{statusText}</Text>
          </View>
        </View>
      </AppPressable>
      {pathArg ? (
        <Text style={[cardFonts(theme).line, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
          Target: {pathArg}
        </Text>
      ) : null}
      {part.result ? (
        <Text style={[cardFonts(theme).line, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
          Result: {stripParenthetical(part.result)}
        </Text>
      ) : null}
      {part.error ? (
        <Text style={[cardFonts(theme).line, { color: theme.colors.error }]} numberOfLines={1}>
          Error: {part.error}
        </Text>
      ) : null}
    </View>
  )
}

/** Read-only preview of a write operation awaiting confirmation (the display part of the old confirmation dialog; no buttons, actions live only inline on the card) */
function WritePreviewDialog({
  visible,
  onClose,
  pending,
}: {
  visible: boolean
  onClose: () => void
  pending: ToolCardDebugWritePending | { tool: WriteToolName; path: string; content?: string; oldContent?: string; overwrite: boolean }
}) {
  const theme = useTheme()
  const isEdit = pending.tool === "edit_file"
  const writeContent = pending.content ?? ""
  return (
    <AppDialog visible={visible} onDismiss={onClose}>
      <AppDialog.Title style={dialogCompact.title}>{isEdit ? "Edit file" : pending.overwrite ? "Overwrite file" : "Write file"}</AppDialog.Title>
      <AppDialog.ScrollArea style={dialogCompact.scrollArea}>
        <View style={{ paddingHorizontal: 2 }}>
          <PaperText variant="bodyMedium" style={{ color: theme.colors.onSurface, marginBottom: 6 }}>
            Path: {pending.path}
          </PaperText>
          {!isEdit && pending.overwrite ? (
            <PaperText variant="bodySmall" style={{ color: theme.colors.error, marginBottom: 6 }}>
              This file already exists and will be overwritten once approved.
            </PaperText>
          ) : null}
          {isEdit ? (
            <View>
              <PreviewBlock label="Original" text={pending.oldContent ?? ""} />
              <PreviewBlock label="Replace with" text={writeContent} />
            </View>
          ) : (
            <View style={[styles.previewBoxLarge, { backgroundColor: theme.colors.surfaceVariant }]}>
              <ScrollView style={{ flex: 1 }}>
                <PaperText variant="bodySmall" selectable style={{ color: theme.colors.onSurface }}>
                  {writeContent}
                </PaperText>
              </ScrollView>
            </View>
          )}
        </View>
      </AppDialog.ScrollArea>
      <AppDialog.Actions style={dialogCompact.actions}>
        <DialogButton onPress={onClose}>Back</DialogButton>
      </AppDialog.Actions>
    </AppDialog>
  )
}

/** download_file success indicator text = downloaded size (icon stays the Done icon); null = fall back to "Done" */
function downloadedBytesLabel(part: MessagePartToolCall): string | null {
  if (part.status !== "ok" || typeof part.result !== "string") return null
  try {
    const value = JSON.parse(part.result) as { bytes?: unknown }
    const n = typeof value?.bytes === "number" ? value.bytes : NaN
    return Number.isFinite(n) && n >= 0 ? formatBytes(n) : null
  } catch {
    return null
  }
}

/**
 * download_file hub card: pending = [Reject][Open][Approve] (Open = neutral outline pill, inspection-only - it shows the
 * "Open external URL" ConfirmDialog, then Linking.openURL; it never settles the confirmation, the card stays Pending);
 * the title/detail tap is the unified ToolDetail screen like every other card (a pending download carries the approval
 * note there - overwrite warning + "downloaded after approval" - instead of a preview dialog);
 * Running = one progress line `done / total` ("?" without Content-Length, fed by toolflow.progress, debug-overridable);
 * Done = the downloaded size as the indicator. The Open button also works in the debug demo (the dialog + browser open are display-safe).
 */
function DownloadToolCard({
  part,
  interactive,
  debugPending,
  debugProgress,
}: {
  part: MessagePartToolCall
  interactive: boolean
  debugPending?: ToolCardDebugDownloadPending
  debugProgress?: ToolCardDebugDownloadProgress
}) {
  const theme = useTheme()
  const navigation = useNavigation<any>()
  const flowSnap = useSnapshot(toolflow)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const realPending = flowSnap.pending.find((p) => p.toolCallId === part.id && p.tool === "download_file")
  const pending = realPending ?? debugPending
  const isDebug = !realPending && !!debugPending

  const pathArg = typeof part.args.path === "string" ? part.args.path : ""
  const urlArg = typeof part.args.url === "string" ? part.args.url : ""
  const path = pending?.path || pathArg
  const url = pending?.url || urlArg

  // Pending state keeps its approval context inside the ToolDetail screen (the write-style preview dialog is gone -
  // the download card aligns with the unified "tap title -> detail screen" behavior of every other tool card):
  const approvalNote = pending ? `${pending.overwrite ? "This file already exists and will be overwritten once approved. " : ""}The file is downloaded after approval.` : undefined
  const openDetail = (indicator: string) => navigation.navigate("ToolDetail", { part, indicator, approvalNote })

  const openUrl = () => {
    setConfirmOpen(false)
    if (!url) return
    Linking.openURL(url).catch(() => showNotice("Could not open the URL in a browser.", { title: "Open failed" }))
  }

  const titleRow = (statusIcon: string, statusLabel: string, statusColor: string) => (
    <View style={styles.titleRow}>
      <View style={styles.metaRow}>
        <Icon source="download-outline" size={14} color={theme.colors.onSurfaceVariant} />
        <Text style={[cardFonts(theme).name, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
          {NAME_LABEL.download_file}
        </Text>
      </View>
      <View style={styles.metaRow}>
        <Icon source={statusIcon} size={14} color={statusColor} />
        <Text style={[cardFonts(theme).status, { color: statusColor }]}>{statusLabel}</Text>
      </View>
    </View>
  )

  const detailRows = (
    <>
      {path ? (
        <Text style={[cardFonts(theme).line, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
          Target: {path}
        </Text>
      ) : null}
      {url ? (
        <Text style={[cardFonts(theme).line, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
          URL: {url}
        </Text>
      ) : null}
    </>
  )

  // Awaiting confirmation on the newest record: title + detail rows tap into the unified ToolDetail screen (with the approval note);
  // buttons stand independently outside (prevents double event delivery); Open never settles the pending.
  if (pending && interactive) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.surfaceVariant }]}>
        <AppPressable onPress={() => openDetail(AWAITING_META.label)}>
          {titleRow(AWAITING_META.icon, AWAITING_META.label, theme.colors.onSurfaceVariant)}
          {detailRows}
        </AppPressable>
        <View style={styles.btnRow}>
          <TagButton
            label="Reject"
            tone="danger"
            onPress={() => {
              if (isDebug || !realPending) return
              resolveWriteConfirmation(realPending.id, false)
            }}
          />
          <TagButton
            label="Approve"
            onPress={() => {
              if (isDebug || !realPending) return
              resolveWriteConfirmation(realPending.id, true)
            }}
          />
          <TagButton label="Open" tone="neutral" onPress={() => setConfirmOpen(true)} />
        </View>
        <ConfirmDialog
          visible={confirmOpen}
          title="Open external URL"
          body={`This will open in your browser outside the app:\n${url}`}
          confirmLabel="Open"
          cancelLabel="Cancel"
          onConfirm={openUrl}
          onCancel={() => setConfirmOpen(false)}
        />
      </View>
    )
  }

  // Awaiting confirmation but not on the newest record (theoretically should not happen): no buttons, keep only the status row
  if (pending) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.surfaceVariant }]}>
        <AppPressable onPress={() => openDetail(AWAITING_META.label)}>{titleRow(AWAITING_META.icon, AWAITING_META.label, theme.colors.onSurfaceVariant)}</AppPressable>
        {detailRows}
      </View>
    )
  }

  // Running / terminal: the ordinary one-line tool card; user_cancelled-class errors display "Cancelled";
  // a successful download carries the downloaded size as the indicator text instead of "Done" (icon unchanged);
  // while the transfer is in flight one progress line rides on top (transient toolflow progress, never persisted).
  const statusColor = part.status === "error" || part.status === "rejected" ? theme.colors.error : theme.colors.onSurfaceVariant
  const statusMeta = part.status ? STATUS_META[part.status] : STATUS_META.running
  const statusText = isCancelledError(part) ? "Cancelled" : part.status === "ok" ? downloadedBytesLabel(part) ?? statusMeta.label : statusMeta.label
  const live = part.status === "running" ? flowSnap.progress[part.id] : undefined
  const received = live?.received ?? (part.status === "running" ? debugProgress?.received : undefined)
  const total = live?.total ?? (live ? 0 : debugProgress?.total ?? 0)

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surfaceVariant }]}>
      <AppPressable onPress={() => openDetail(statusText)}>{titleRow(statusMeta.icon, statusText, statusColor)}</AppPressable>
      {detailRows}
      {received !== undefined ? (
        <Text style={[cardFonts(theme).line, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
          Progress: {formatBytes(received)} / {total > 0 ? formatBytes(total) : "?"}
        </Text>
      ) : null}
      {part.result ? (
        <Text style={[cardFonts(theme).line, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
          Result: {stripParenthetical(part.result)}
        </Text>
      ) : null}
      {part.error ? (
        <Text style={[cardFonts(theme).line, { color: theme.colors.error }]} numberOfLines={1}>
          Error: {part.error}
        </Text>
      ) : null}
    </View>
  )
}

function formErrorLabel(part: MessagePartToolCall): string {
  if (part.status === "rejected") return "Rejected"
  const e = part.error ?? ""
  if (e.startsWith("user_rejected")) return "Rejected"
  if (e.startsWith("user_cancelled")) return "Cancelled"
  return "Failed"
}

function FormToolCard({ part, interactive }: { part: MessagePartToolCall; interactive: boolean }) {
  const theme = useTheme()
  const navigation = useNavigation<any>()
  const flowSnap = useSnapshot(formflow)
  const [confirmReject, setConfirmReject] = useState(false)
  const pending = flowSnap.pending.find((p) => p.toolCallId === part.id)

  const htmlArg = typeof part.args.html === "string" ? part.args.html : ""
  const htmlPathArg = typeof part.args.html_path === "string" ? part.args.html_path : ""
  // Header detail row: where the form came from - inline HTML ("inline") or the project file path
  const sourceText = htmlArg ? "inline" : htmlPathArg
  const sizeBytes = htmlArg ? utf8ByteLength(htmlArg) : flowSnap.sizes[part.id] ?? pending?.sizeBytes ?? 0
  const sizeLabel = sizeBytes > 0 ? formatBytes(sizeBytes) : ""
  // The model-supplied show_form `title` is deliberately NOT rendered here: the card title row is always just
  // "Show form + status", and the title surfaces only where it belongs - the FormFull Appbar header (rule: unified card layout).

  const neutral = theme.colors.onSurfaceVariant
  let statusIcon = AWAITING_META.icon
  let statusLabel = AWAITING_META.label
  let statusColor: string = neutral
  let showSize = false
  let extraLine: React.ReactNode = null
  let actionRow: React.ReactNode = null

  if (pending) {
    statusIcon = AWAITING_META.icon
    statusLabel = AWAITING_META.label
    showSize = !!sizeLabel
    if (interactive) {
      actionRow = (
        <View style={styles.btnRow}>
          <TagButton label="Reject" tone="danger" onPress={() => setConfirmReject(true)} />
          <TagButton label="Open" onPress={() => navigation.navigate("FormFull", { toolCallId: part.id })} />
        </View>
      )
    }
  } else if (part.status === "running") {
    statusIcon = STATUS_META.running.icon
    statusLabel = STATUS_META.running.label
    showSize = !!sizeLabel
  } else if (part.status === "ok") {
    statusIcon = STATUS_META.ok.icon
    statusLabel = STATUS_META.ok.label
    extraLine = part.result ? (
      <Text style={[cardFonts(theme).line, { color: neutral }]} numberOfLines={1}>
        Result: {stripParenthetical(part.result)}
      </Text>
    ) : null
  } else {
    statusIcon = STATUS_META.error.icon
    statusLabel = formErrorLabel(part)
    statusColor = theme.colors.error
    extraLine = part.error ? (
      <Text style={[cardFonts(theme).line, { color: theme.colors.error }]} numberOfLines={1}>
        Error: {part.error}
      </Text>
    ) : null
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surfaceVariant }]}>
      <AppPressable onPress={() => navigation.navigate("ToolDetail", { part, indicator: statusLabel })}>
        <View style={styles.titleRow}>
          <View style={styles.metaRow}>
            <Icon source="form-select" size={14} color={neutral} />
            <Text style={[cardFonts(theme).name, { color: neutral, flexShrink: 0 }]} numberOfLines={1}>
              {NAME_LABEL.show_form}
            </Text>
          </View>
          <View style={styles.metaRow}>
            <Icon source={statusIcon} size={14} color={statusColor} />
            <Text style={[cardFonts(theme).status, { color: statusColor }]} numberOfLines={1}>
              {statusLabel}
            </Text>
            {showSize ? (
              <Text style={[cardFonts(theme).status, { color: neutral }]} numberOfLines={1}>
                {sizeLabel}
              </Text>
            ) : null}
          </View>
        </View>
      </AppPressable>
      {sourceText ? (
        <Text style={[cardFonts(theme).line, { color: neutral }]} numberOfLines={1}>
          Source: {sourceText}
        </Text>
      ) : null}
      {extraLine}
      {actionRow}
      <AppDialog visible={confirmReject} onDismiss={() => setConfirmReject(false)}>
        <AppDialog.Title style={dialogCompact.title}>Discard this form?</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 14) }}>Anything filled in so far will be lost; the AI will be notified.</Text>
        </AppDialog.Content>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => setConfirmReject(false)}>Keep filling</DialogButton>
          <DialogButton
            textColor={theme.colors.error}
            onPress={() => {
              setConfirmReject(false)
              rejectForm(part.id)
            }}
          >
            Discard
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 4,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  titleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 1,
  },
  btnRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4,
  },
  previewBox: {
    borderRadius: 8,
    padding: 8,
  },
  previewBoxLarge: {
    height: 260,
    borderRadius: 8,
    padding: 10,
  },
})
