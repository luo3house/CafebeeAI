/**
 * Shared YAML transfer dialogs (rule 38): the one component every transfer surface rides on — the four
 * kind pages (Providers / Git Credentials / System Prompts / Skills header icons) and the Settings page
 * "Export all data" / "Import data" list items.
 *
 * Export dialog: explanatory copy (+ the "Include secrets" CheckRow on surfaces that host secrets — checkbox
 * defaults OFF and resets every open, rule 38) + vertically stacked actions:
 *   [Save as file] -> stage into the cache, open the FilePreview screen ("Open with..." shares from there)
 *   [View in editor] -> TextEditor readOnly view of the exact stream that would be saved (copy / inspect)
 *   [Cancel]
 * Import dialog: [Choose file...] (document picker + cache copy, 2 MB cap) or [Enter text] (full-screen
 * TextEditor: validate = side-effect-free precheck that ABORTS on unknown kinds, onSave = apply).
 * Result: errors>0 -> report dialog (`document #n (kind): message` rows); otherwise a toast summary
 * ("Imported N, skipped M" / "Nothing imported (M skipped)"). Accepted-but-unlisted kinds count as skipped;
 * structural problems abort the whole import with zero writes (never partially applied).
 */
import React, { useCallback, useState } from "react"
import { ScrollView, StyleSheet, Text, View } from "react-native"
import { useTheme } from "react-native-paper"
import { pick, keepLocalCopy } from "@react-native-documents/picker"
import { fs } from "../../app/app.ui.theme"
import { AppDialog } from "./app-dialog"
import { dialogCompact } from "./dialog-compact"
import { DialogButton } from "./dialog-button"
import { CheckRow } from "./option-row"
import { showNotice } from "../../state/notice"
import { showToast } from "../../state/toast"
import type { TextEditorValidation } from "../../core/text-editor"
import {
  TransferAbortError,
  applyLoaded,
  importYamlFor,
  precheckYamlFor,
  readTransferFile,
  renderAcceptedYaml,
  stageTransferYaml,
  type LoadedStream,
  type TransferReport,
} from "../../core/transfer-registry"

export interface YamlTransferOptions {
  navigation: any
  /** kinds this surface imports (single kind on pages; all five on Settings "Import data") */
  accepted: readonly string[]
  /** staged backup file name prefix: `providers` -> `providers-<ts>.yaml` */
  filePrefix: string
  /** dialog titles / TextEditor labels, e.g. "providers" */
  noun: string
  /** export dialog body (what the stream contains) */
  exportDescription: string
  /** import dialog body (what gets applied) */
  importDescription: string
  /** render the "Include secrets" checkbox (providers / git credentials / full backup) */
  withSecrets: boolean
  /** page list refresh after a successful import */
  onApplied?: () => void
}

export interface YamlTransferControls {
  exporting: boolean
  importing: boolean
  openExport: () => void
  openImport: () => void
  /** mount exactly once per screen */
  dialogs: React.ReactElement
}

export function useYamlTransfer(opts: YamlTransferOptions): YamlTransferControls {
  const theme = useTheme()
  const { navigation, accepted, filePrefix, noun, withSecrets } = opts
  const [exportDlg, setExportDlg] = useState(false)
  const [importDlg, setImportDlg] = useState(false)
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [report, setReport] = useState<TransferReport | null>(null)

  const openExport = useCallback(() => {
    setIncludeSecrets(false) // rule 38: the checkbox resets every open — never sticky
    setExportDlg(true)
  }, [])

  const renderStreamNow = useCallback(async (): Promise<string> => {
    return renderAcceptedYaml(accepted, withSecrets ? includeSecrets : false)
  }, [accepted, withSecrets, includeSecrets])

  const doSaveAsFile = useCallback(async () => {
    setExporting(true)
    try {
      const text = await renderStreamNow()
      if (!text) {
        setExportDlg(false)
        showToast(`No ${noun} to export`)
        return
      }
      const { name, path } = await stageTransferYaml(filePrefix, text)
      setExportDlg(false)
      navigation.navigate("FilePreview", { name, path })
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Export failed" })
    } finally {
      setExporting(false)
    }
  }, [renderStreamNow, filePrefix, noun, navigation])

  const doViewInEditor = useCallback(async () => {
    try {
      const text = await renderStreamNow()
      setExportDlg(false)
      navigation.navigate("TextEditor", { label: `${noun} export (preview)`, initialText: text, readOnly: true })
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Export failed" })
    }
  }, [renderStreamNow, noun, navigation])

  const showImportOutcome = useCallback(
    (r: TransferReport) => {
      opts.onApplied?.()
      if (r.errors.length > 0) {
        setReport(r)
        return
      }
      const applied = r.created + r.updated
      if (applied > 0) showToast(`Imported ${applied}${r.skipped > 0 ? `, skipped ${r.skipped}` : ""}`)
      else showToast(`Nothing imported${r.skipped > 0 ? ` (${r.skipped} skipped)` : ""}`)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.onApplied],
  )

  const doImportFromFile = useCallback(async () => {
    setImportDlg(false)
    try {
      const result = await pick({
        allowMultiSelection: false,
        mode: "open",
        type: ["application/yaml", "application/x-yaml", "text/yaml", "text/plain"],
      })
      const doc = result[0]
      if (!doc) return
      let localPath = doc.uri
      if (localPath.startsWith("content://")) {
        const copies = await keepLocalCopy({ destination: "cachesDirectory", files: [{ uri: doc.uri, fileName: doc.name ?? `${filePrefix}.yaml` }] })
        const copy = copies[0]
        if (copy.status === "success" && copy.localUri) localPath = copy.localUri
      }
      setImporting(true)
      const text = await readTransferFile(localPath)
      try {
        const r = await importYamlFor(accepted, text)
        showImportOutcome(r)
      } catch (err: any) {
        if (err instanceof TransferAbortError) showNotice(String(err.message ?? err), { title: "Import aborted" })
        else throw err
      }
    } catch (err: any) {
      if (err?.code === "DOCUMENT_PICKER_CANCELED") return
      showNotice(String(err?.message ?? err), { title: "Import failed" })
    } finally {
      setImporting(false)
    }
  }, [accepted, filePrefix, showImportOutcome])

  // TextEditor paste flow: validate = the same side-effect-free precheck the file flow runs first, so an
  // unknown kind aborts BEFORE any save; onSave applies exactly what the precheck accepted.
  const validateImportText = useCallback(async (text: string): Promise<TextEditorValidation> => {
    try {
      const loaded = precheckYamlFor(accepted, text)
      if (loaded.errors.length > 0) return { ok: false, message: `Some documents are invalid:\n${loaded.errors.slice(0, 4).join("\n")}` }
      if (loaded.docs.length === 0) {
        return {
          ok: false,
          message: loaded.skipped > 0 ? `Nothing to import here (${loaded.skipped} documents of other kinds — use Settings "Import data" for a full backup).` : "No documents found in this stream.",
        }
      }
      return { ok: true, value: loaded }
    } catch (err: any) {
      if (err instanceof TransferAbortError) return { ok: false, message: String(err.message ?? err) }
      throw err
    }
  }, [accepted])

  const doImportFromText = useCallback(() => {
    setImportDlg(false)
    navigation.navigate("TextEditor", {
      label: `Import ${noun} (YAML)`,
      initialText: "",
      validate: validateImportText,
      onSave: async (value: unknown) => {
        const loaded = value as LoadedStream
        const r = await applyLoaded(loaded)
        showImportOutcome(r)
      },
    })
  }, [navigation, noun, validateImportText, showImportOutcome])

  const bodyStyle = { color: theme.colors.onSurface, fontSize: fs(theme, 14) }
  const hintStyle = { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }

  const dialogs = (
    <>
      <AppDialog visible={exportDlg} onDismiss={() => setExportDlg(false)}>
        <AppDialog.Title style={dialogCompact.title}>Export {noun}</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <Text style={bodyStyle}>{opts.exportDescription}</Text>
          {withSecrets ? (
            <View style={styles.secretsRow}>
              <CheckRow
                checked={includeSecrets}
                onPress={() => setIncludeSecrets((v) => !v)}
                title="Include secrets"
                description={
                  includeSecrets
                    ? "The exported file will contain plain-text secrets — share carefully."
                    : "Off: secrets are written as \"-- DEDUCTED --\" placeholders — the file stays importable and safe to share."
                }
              />
            </View>
          ) : null}
        </AppDialog.Content>
        <AppDialog.Actions style={[dialogCompact.actions, styles.stackActions]}>
          <DialogButton mode="contained" loading={exporting} onPress={doSaveAsFile}>
            Save as file
          </DialogButton>
          <DialogButton onPress={doViewInEditor}>View in editor</DialogButton>
          <DialogButton onPress={() => setExportDlg(false)}>Cancel</DialogButton>
        </AppDialog.Actions>
      </AppDialog>

      <AppDialog visible={importDlg} onDismiss={() => setImportDlg(false)}>
        <AppDialog.Title style={dialogCompact.title}>Import {noun}</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <Text style={bodyStyle}>{opts.importDescription}</Text>
          <Text style={hintStyle}>
            An existing entry with the same id updates in place; a free or missing id creates one (ids are kept).
            Secrets sent as placeholders are left untouched.
          </Text>
        </AppDialog.Content>
        <AppDialog.Actions style={[dialogCompact.actions, styles.stackActions]}>
          <DialogButton onPress={doImportFromFile}>Choose file...</DialogButton>
          <DialogButton mode="contained" onPress={doImportFromText}>
            Enter text
          </DialogButton>
          <DialogButton onPress={() => setImportDlg(false)}>Cancel</DialogButton>
        </AppDialog.Actions>
      </AppDialog>

      <AppDialog visible={report !== null} onDismiss={() => setReport(null)}>
        <AppDialog.Title style={dialogCompact.title}>Import {noun}</AppDialog.Title>
        <AppDialog.ScrollArea style={dialogCompact.scrollArea}>
          <ScrollView>
            <Text style={bodyStyle} selectable={false}>
              {`Applied: ${report?.created ?? 0} created, ${report?.updated ?? 0} updated` +
                (report && report.skipped > 0 ? `, ${report.skipped} skipped` : "") +
                ((report?.errors.length ?? 0) > 0 ? `\n\nIssues:\n${report!.errors.join("\n")}` : "")}
            </Text>
          </ScrollView>
        </AppDialog.ScrollArea>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => setReport(null)}>OK</DialogButton>
        </AppDialog.Actions>
      </AppDialog>
    </>
  )

  return {
    exporting,
    importing,
    openExport,
    openImport: useCallback(() => setImportDlg(true), []),
    dialogs,
  }
}

const styles = StyleSheet.create({
  secretsRow: { marginTop: 10 },
  // three stacked full-width actions like the providers import dialog (a horizontal row overflows the card)
  stackActions: { flexDirection: "column", alignItems: "stretch", gap: 6, paddingBottom: 16 },
})
