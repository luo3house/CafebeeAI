/**
 * Debug page: a showcase of every tool_call card component (one row per demo: 3~4-word title cell + content cell,
 * display-only with no real function, used to check that card styling is aligned).
 * Write confirmation is now inline on the tool card (no popup); the demo covers the "pending confirmation" card form via debugWritePending:
 * buttons hook to no real action and tapping the card opens the read-only preview. The download card demos the same override shape
 * (debugDownloadPending for the [Reject][Open][Approve] hub form; Open still shows the real "Open external URL" confirm dialog and links out,
 * and the body tap routes to the real ToolDetail screen (with the pending approval note) - display-safe; progress rides debugDownloadProgress,
 * total-less variant included; Done carries the size indicator).
 * The form card has no debug override - its pending hub form
 * only appears with a real formflow session; the demo covers the queued/Done/Rejected/Cancelled terminal states.
 * The "Snackbar toast" row fires the real global Snackbar (raised 10% of screen height, 85% opacity) via showToast.
 */
import React from "react"
import { ScrollView, StyleSheet, Text, View } from "react-native"
import { useTheme } from "react-native-paper"
import { fs } from "../../../app/app.ui.theme"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { showNotice } from "../../../state/notice"
import { showToast } from "../../../state/toast"
import { TagButton } from "../../components/tag-button"
import { GitDemoSection } from "./git-demo.section"
import { NotificationDemoSection } from "./notification-demo.section"
import {
  ToolCard,
  type ToolCardDebugWritePending,
  type ToolCardDebugDownloadPending,
  type ToolCardDebugDownloadProgress,
} from "../../components/tool-card"
import type { MessagePartToolCall } from "../../../core/chats"

interface ToolCardDemo {
  key: string
  title: string
  part: MessagePartToolCall
  debugWritePending?: ToolCardDebugWritePending
  debugDownloadPending?: ToolCardDebugDownloadPending
  debugDownloadProgress?: ToolCardDebugDownloadProgress
}

const hairline = StyleSheet.hairlineWidth

const DEMO_WRITE_CONTENT = `# Sample text

This is example content for the write_file pending-confirmation card preview.

- List item 1
- List item 2

const answer = 42`

const DEMO_FORM_HTML = `<form><label>City <input name="city" /></label><button>Submit</button></form>`

const DEMO_FORM_PATH = "forms/survey.html"

const DEMO_DOWNLOAD_URL = "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css"
const DEMO_DOWNLOAD_PATH = "vendor/bootstrap.min.css"

const TOOL_CARD_DEMOS: ToolCardDemo[] = [
  {
    key: "read-ok",
    title: "Read file done",
    part: {
      type: "tool_call", id: "dbg_read_ok", name: "read_file", status: "ok",
      args: { path: "notes/todo.md" }, result: "Read notes/todo.md (42 lines)",
    },
  },
  {
    key: "read-error",
    title: "Read file failed",
    part: {
      type: "tool_call", id: "dbg_read_err", name: "read_file", status: "error",
      args: { path: "missing.txt" }, error: "File not found: missing.txt",
    },
  },
  {
    key: "list-ok",
    title: "List files done",
    part: {
      type: "tool_call", id: "dbg_list_ok", name: "list_files", status: "ok",
      args: { path: "docs" }, result: "4 entries: a.md, b.md, c.txt, img/",
    },
  },
  {
    key: "search-ok",
    title: "Search files done",
    part: {
      type: "tool_call", id: "dbg_search_ok", name: "search_files", status: "ok",
      args: { pattern: "TODO", path: "." }, result: "3 matches (notes/todo.md:12, src/app.ts:44, README.md:8)",
    },
  },
  {
    key: "search-running",
    title: "Search files running",
    part: {
      type: "tool_call", id: "dbg_search_run", name: "search_files", status: "running",
      args: { pattern: "provider", path: "." },
    },
  },
  {
    key: "search-error",
    title: "Search files failed",
    part: {
      type: "tool_call", id: "dbg_search_err", name: "search_files", status: "error",
      args: { pattern: "[a-", path: "." }, error: "Invalid regular expression",
    },
  },
  {
    key: "write-pending",
    title: "Write file pending",
    part: {
      type: "tool_call", id: "dbg_write_pend", name: "write_file", status: "running",
      args: { path: "demo/sample.txt" },
    },
    debugWritePending: { tool: "write_file", path: "demo/sample.txt", content: DEMO_WRITE_CONTENT, overwrite: false },
  },
  {
    key: "write-pending-overwrite",
    title: "Overwrite file pending",
    part: {
      type: "tool_call", id: "dbg_write_pend_ow", name: "write_file", status: "running",
      args: { path: "demo/sample.txt" },
    },
    debugWritePending: { tool: "write_file", path: "demo/sample.txt", content: DEMO_WRITE_CONTENT, overwrite: true },
  },
  {
    key: "edit-pending",
    title: "Edit file pending",
    part: {
      type: "tool_call", id: "dbg_edit_pend", name: "edit_file", status: "running",
      args: { path: "src/app.ts" },
    },
    debugWritePending: {
      tool: "edit_file", path: "src/app.ts",
      oldContent: "const answer = 41\nconst stale = true", content: "const answer = 42\nconst fresh = true", overwrite: true,
    },
  },
  {
    key: "write-running",
    title: "Write file running",
    part: {
      type: "tool_call", id: "dbg_write_run", name: "write_file", status: "running",
      args: { path: "demo/sample.txt" },
    },
  },
  {
    key: "write-ok",
    title: "Write file done",
    part: {
      type: "tool_call", id: "dbg_write_ok", name: "write_file", status: "ok",
      args: { path: "demo/sample.txt", content: DEMO_WRITE_CONTENT }, result: "Wrote demo/sample.txt (128 bytes)",
    },
  },
  {
    key: "write-rejected",
    title: "Write file rejected",
    part: {
      type: "tool_call", id: "dbg_write_rej", name: "write_file", status: "rejected",
      args: { path: "demo/sample.txt" }, error: "The user rejected this write request",
    },
  },
  {
    key: "edit-ok",
    title: "Edit file done",
    part: {
      type: "tool_call", id: "dbg_edit_ok", name: "edit_file", status: "ok",
      args: { path: "src/app.ts", old_string: "const answer = 41", new_string: "const answer = 42\nconst fresh = true" },
      result: "Replaced 1 occurrence (src/app.ts)",
    },
  },
  {
    key: "edit-error",
    title: "Edit file failed",
    part: {
      type: "tool_call", id: "dbg_edit_err", name: "edit_file", status: "error",
      args: { path: "src/app.ts" }, error: "old_string not found in src/app.ts",
    },
  },
  {
    key: "download-pending",
    title: "Download file pending",
    part: {
      type: "tool_call", id: "dbg_dl_pend", name: "download_file", status: "running",
      args: { url: DEMO_DOWNLOAD_URL, path: DEMO_DOWNLOAD_PATH },
    },
    debugDownloadPending: { url: DEMO_DOWNLOAD_URL, path: DEMO_DOWNLOAD_PATH, overwrite: false },
  },
  {
    key: "download-pending-overwrite",
    title: "Download overwrite pending",
    part: {
      type: "tool_call", id: "dbg_dl_pend_ow", name: "download_file", status: "running",
      args: { url: DEMO_DOWNLOAD_URL, path: DEMO_DOWNLOAD_PATH },
    },
    debugDownloadPending: { url: DEMO_DOWNLOAD_URL, path: DEMO_DOWNLOAD_PATH, overwrite: true },
  },
  {
    key: "download-running",
    title: "Download running",
    part: {
      type: "tool_call", id: "dbg_dl_run", name: "download_file", status: "running",
      args: { url: DEMO_DOWNLOAD_URL, path: DEMO_DOWNLOAD_PATH },
    },
    debugDownloadProgress: { received: 389120, total: 1256662 },
  },
  {
    key: "download-running-unknown",
    title: "Download running (no length)",
    part: {
      type: "tool_call", id: "dbg_dl_run_unk", name: "download_file", status: "running",
      args: { url: DEMO_DOWNLOAD_URL, path: DEMO_DOWNLOAD_PATH },
    },
    debugDownloadProgress: { received: 819200 },
  },
  {
    key: "download-ok",
    title: "Download file done",
    part: {
      type: "tool_call", id: "dbg_dl_ok", name: "download_file", status: "ok",
      args: { url: DEMO_DOWNLOAD_URL, path: DEMO_DOWNLOAD_PATH },
      result: '{"ok":true,"bytes":1256662,"overwritten":false}',
    },
  },
  {
    key: "download-error",
    title: "Download file failed",
    part: {
      type: "tool_call", id: "dbg_dl_err", name: "download_file", status: "error",
      args: { url: DEMO_DOWNLOAD_URL, path: DEMO_DOWNLOAD_PATH }, error: "Download failed: HTTP 404",
    },
  },
  {
    key: "download-rejected",
    title: "Download file rejected",
    part: {
      type: "tool_call", id: "dbg_dl_rej", name: "download_file", status: "rejected",
      args: { url: DEMO_DOWNLOAD_URL, path: DEMO_DOWNLOAD_PATH }, error: "The user rejected this download request",
    },
  },
  {
    key: "download-cancelled",
    title: "Download file cancelled",
    part: {
      type: "tool_call", id: "dbg_dl_cancel", name: "download_file", status: "error",
      args: { url: DEMO_DOWNLOAD_URL, path: DEMO_DOWNLOAD_PATH }, error: "user_cancelled: The user has interrupted this operation.",
    },
  },
  {
    key: "form-queued",
    title: "Form running",
    part: { type: "tool_call", id: "dbg_form_queue", name: "show_form", status: "running", args: { html_path: DEMO_FORM_PATH } },
  },
  {
    key: "form-ok",
    title: "Form done",
    part: {
      type: "tool_call", id: "dbg_form_ok", name: "show_form", status: "ok", args: { html: DEMO_FORM_HTML },
      result: '{"fields":{"name":"Lin","city":"Hangzhou"},"submitter":"user"}',
    },
  },
  {
    key: "form-rejected",
    title: "Form rejected",
    part: {
      type: "tool_call", id: "dbg_form_rej", name: "show_form", status: "rejected",
      args: { html_path: DEMO_FORM_PATH }, error: "user_rejected: The user declined to fill out the form.",
    },
  },
  {
    key: "form-cancelled",
    title: "Form cancelled",
    part: {
      type: "tool_call", id: "dbg_form_cancel", name: "show_form", status: "error",
      args: {}, error: "user_cancelled: The user has interrupted this operation.",
    },
  },
]

export function DebugScreen() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 12, paddingBottom: insets.bottom + 12 }}>
      <NotificationDemoSection />
      <GitDemoSection />
      <View style={[styles.table, { borderColor: theme.colors.outlineVariant }]}>
        <View style={[styles.row, { borderBottomWidth: hairline, borderColor: theme.colors.outlineVariant }]}>
          <View style={[styles.titleCell, { borderRightWidth: hairline, borderColor: theme.colors.outlineVariant }]}>
              <Text style={[styles.cellLabel, { color: theme.colors.onSurface, fontSize: fs(theme, 13), lineHeight: fs(theme, 17) }]} numberOfLines={2}>
              Problem notice dialog
            </Text>
          </View>
          <View style={styles.contentCell}>
            <View style={styles.btnRow}>
              <TagButton label="Show dialog" onPress={() => showNotice("Import failed: could not read the selected file.", { title: "Import failed" })} />
            </View>
          </View>
        </View>
        <View style={[styles.row, { borderBottomWidth: hairline, borderColor: theme.colors.outlineVariant }]}>
          <View style={[styles.titleCell, { borderRightWidth: hairline, borderColor: theme.colors.outlineVariant }]}>
              <Text style={[styles.cellLabel, { color: theme.colors.onSurface, fontSize: fs(theme, 13), lineHeight: fs(theme, 17) }]} numberOfLines={2}>
              Snackbar toast
            </Text>
          </View>
          <View style={styles.contentCell}>
            <View style={styles.btnRow}>
              <TagButton label="Show toast" onPress={() => showToast("Saved")} />
              <TagButton label="Long toast" tone="neutral" onPress={() => showToast("Export complete: cafebeeai-project-20261119-1130.zip is ready in the share sheet.")} />
            </View>
          </View>
        </View>
        <View style={[styles.row, { borderBottomWidth: hairline, borderColor: theme.colors.outlineVariant }]}>
          <View style={[styles.titleCell, { borderRightWidth: hairline, borderColor: theme.colors.outlineVariant }]}>
              <Text style={[styles.cellLabel, { color: theme.colors.onSurface, fontSize: fs(theme, 13), lineHeight: fs(theme, 17) }]} numberOfLines={2}>
              Inline approval buttons
            </Text>
          </View>
          <View style={styles.contentCell}>
            <View style={styles.btnRow}>
              <TagButton label="Reject" tone="danger" />
              <TagButton label="Approve" />
            </View>
          </View>
        </View>
        {TOOL_CARD_DEMOS.map((d) => (
          <View key={d.key} style={[styles.row, { borderBottomWidth: hairline, borderColor: theme.colors.outlineVariant }]}>
            <View style={[styles.titleCell, { borderRightWidth: hairline, borderColor: theme.colors.outlineVariant }]}>
            <Text style={[styles.cellLabel, { color: theme.colors.onSurface, fontSize: fs(theme, 13), lineHeight: fs(theme, 17) }]} numberOfLines={2}>
                {d.title}
              </Text>
            </View>
            <View style={styles.contentCell}>
              <ToolCard
                part={d.part}
                debugWritePending={d.debugWritePending}
                debugDownloadPending={d.debugDownloadPending}
                debugDownloadProgress={d.debugDownloadProgress}
              />
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  table: { borderTopWidth: hairline, borderLeftWidth: hairline },
  row: { flexDirection: "row", minHeight: 56 },
  titleCell: { width: "30%", justifyContent: "center", padding: 8 },
  contentCell: { flex: 1, justifyContent: "center", padding: 6 },
  cellLabel: { fontSize: 13, lineHeight: 17, fontWeight: "600" },
  btnRow: { flexDirection: "row", alignItems: "center", gap: 8 },
})
