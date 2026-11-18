/**
 * Provider list page: add/edit/delete (deleting requires confirmation and clears project preferences referencing it),
 * plus YAML transfer in the PageHeader with explanatory confirm dialogs first (export-then-share and
 * import-then-paste are not guessable from bare icons):
 * - Export: renders the secret-free `v1/providers` stream, stages it into the cache and opens the File Preview
 *   screen (code view) - sharing / external opening happens there via "Open with...".
 * - Import: dialog offers "Choose file..." (document picker) or "Enter text" (full-screen TextEditor; docs are
 *   pre-checked by the async validate, applied in the save callback).
 * Refreshes on focus (useFocusEffect): the list updates automatically after the form page saves and returns; pull-to-refresh also supported.
 */
import React, { useCallback, useLayoutEffect, useState } from "react"
import { FlatList, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { Card, IconButton, List, useTheme } from "react-native-paper"
import { useFocusEffect } from "@react-navigation/native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { pick, keepLocalCopy } from "@react-native-documents/picker"
import { kProviderRegistry, type LLMProvider } from "../../../core/providers"
import { fs } from "../../../app/app.ui.theme"
import { getProjectListIdsByPreferProvider, cleanupPreferences } from "../../../core/providers-cleanup"
import {
  stageProvidersYaml,
  parseProvidersYamlText,
  importProvidersDocs,
  importProvidersYaml,
  readProvidersYamlFile,
  type ParsedProviderDoc,
  type ProvidersImportReport,
} from "../../../core/providers-transfer"
import type { TextEditorValidation } from "../../../core/text-editor"
import { showToast } from "../../../state/toast"
import { showNotice } from "../../../state/notice"
import { ConfirmDialog } from "../../components/confirm-dialog"
import { AppDialog } from "../../components/app-dialog"
import { dialogCompact } from "../../components/dialog-compact"
import { DialogButton } from "../../components/dialog-button"

export function ProvidersScreen({ navigation }: { navigation: any }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [deleting, setDeleting] = useState<LLMProvider | null>(null)
  const [importReport, setImportReport] = useState<ProvidersImportReport | null>(null)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [exportDlg, setExportDlg] = useState(false)
  const [importDlg, setImportDlg] = useState(false)

  const refresh = useCallback(() => setProviders(kProviderRegistry().getAll()), [])

  useFocusEffect(refresh)

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    refresh()
    setRefreshing(false)
  }, [refresh])

  const doDelete = async () => {
    if (!deleting) return
    const affected = await getProjectListIdsByPreferProvider(deleting.id)
    await kProviderRegistry().remove(deleting.id)
    await cleanupPreferences(deleting.id, affected)
    setDeleting(null)
    showToast("Provider deleted")
    refresh()
  }

  const doExportYaml = useCallback(async () => {
    setExporting(true)
    try {
      const { name, path } = await stageProvidersYaml()
      setExportDlg(false)
      navigation.navigate("FilePreview", { name, path })
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Export failed" })
    } finally {
      setExporting(false)
    }
  }, [navigation])

  const showImportReport = useCallback(
    (report: ProvidersImportReport) => {
      refresh()
      if (report.errors.length > 0) setImportReport(report)
      else showToast(`Providers imported: ${report.created} created, ${report.updated} updated`)
    },
    [refresh],
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
        const copies = await keepLocalCopy({ destination: "cachesDirectory", files: [{ uri: doc.uri, fileName: doc.name ?? "providers.yaml" }] })
        const copy = copies[0]
        if (copy.status === "success" && copy.localUri) localPath = copy.localUri
      }
      setImporting(true)
      const text = await readProvidersYamlFile(localPath)
      const report = await importProvidersYaml(text)
      showImportReport(report)
    } catch (err: any) {
      if (err?.code === "DOCUMENT_PICKER_CANCELED") return
      showNotice(String(err?.message ?? err), { title: "Import failed" })
    } finally {
      setImporting(false)
    }
  }, [showImportReport])

  // Text paste import (requirement: the full-screen TextEditor drives it - validate pre-checks every document
  // without applying, the save callback receives the parsed docs and applies them like the file path).
  const validateProvidersText = useCallback(async (text: string): Promise<TextEditorValidation> => {
    const { docs, errors } = parseProvidersYamlText(text)
    if (errors.length > 0) return { ok: false, message: `Invalid YAML stream:\n${errors.slice(0, 4).join("\n")}` }
    if (docs.length === 0) return { ok: false, message: "No 'v1/providers' documents found." }
    return { ok: true, value: docs }
  }, [])

  const doImportFromText = useCallback(() => {
    setImportDlg(false)
    navigation.navigate("TextEditor", {
      label: "Import Providers (YAML)",
      initialText: "",
      validate: validateProvidersText,
      onSave: async (value: unknown) => {
        const docs = (Array.isArray(value) ? value : []) as ParsedProviderDoc[]
        const report = await importProvidersDocs(docs)
        showImportReport(report)
      },
    })
  }, [navigation, validateProvidersText, showImportReport])

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <IconButton icon="export-variant" size={20} disabled={exporting} onPress={() => setExportDlg(true)} />
          <IconButton icon="file-import" size={20} disabled={importing} onPress={() => setImportDlg(true)} />
          <IconButton icon="plus" size={20} onPress={() => navigation.navigate("ProviderForm", { providerId: undefined })} />
        </View>
      ),
    })
  }, [navigation, exporting, importing])

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      <FlatList
        data={providers}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.listPad}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        renderItem={({ item }) => (
          <Card style={styles.card}>
            <Card.Title
              style={styles.cardTitle}
              title={item.name}
              titleNumberOfLines={1}
              subtitle={`${item.baseURL}\n${(item.modelNamesCache ?? []).length} models cached`}
              subtitleNumberOfLines={1}
              left={(p) => <List.Icon {...p} icon="server-network" />}
              right={() => (
                <View style={styles.cardActions}>
                  <IconButton icon="pencil-outline" size={20} onPress={() => navigation.navigate("ProviderForm", { providerId: item.id })} />
                  <IconButton icon="delete-outline" size={20} onPress={() => setDeleting(item)} />
                </View>
              )}
            />
          </Card>
        )}
        ListEmptyComponent={<Text style={[styles.empty, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 14) }]}>No providers yet</Text>}
      />

      <ConfirmDialog
        visible={deleting !== null}
        title="Delete Provider"
        body={`Delete ${deleting?.name}?`}
        confirmLabel="Delete"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={doDelete}
      />

      <AppDialog visible={exportDlg} onDismiss={() => setExportDlg(false)}>
        <AppDialog.Title style={dialogCompact.title}>Export Providers</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <Text style={{ color: theme.colors.onSurface, fontSize: fs(theme, 14) }}>
            The registry is rendered as a secret-free YAML stream (names and endpoints only - never API keys or header values). The
            file is saved into the app cache and opened in File Preview, where &quot;Open with...&quot; shares or exports it.
          </Text>
        </AppDialog.Content>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => setExportDlg(false)}>Cancel</DialogButton>
          <DialogButton mode="contained" loading={exporting} onPress={doExportYaml}>
            Export
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>

      <AppDialog visible={importDlg} onDismiss={() => setImportDlg(false)}>
        <AppDialog.Title style={dialogCompact.title}>Import Providers</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <Text style={{ color: theme.colors.onSurface, fontSize: fs(theme, 14) }}>
            Import providers from a {`v1/providers`} YAML stream: pick an existing .yaml file, or enter the text to review it before
            applying. Any carried secrets go into encrypted storage only.
          </Text>
        </AppDialog.Content>
        <AppDialog.Actions style={[dialogCompact.actions, styles.stackActions]}>
          <DialogButton onPress={() => setImportDlg(false)}>Cancel</DialogButton>
          <DialogButton onPress={doImportFromFile}>Choose file...</DialogButton>
          <DialogButton mode="contained" onPress={doImportFromText}>
            Enter text
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>

      <AppDialog visible={importReport !== null} onDismiss={() => setImportReport(null)}>
        <AppDialog.Title style={dialogCompact.title}>Import Providers</AppDialog.Title>
        <AppDialog.ScrollArea style={dialogCompact.scrollArea}>
          <ScrollView>
            <Text style={{ color: theme.colors.onSurface, fontSize: fs(theme, 14) }} selectable={false}>
              {`Applied: ${importReport?.created ?? 0} created, ${importReport?.updated ?? 0} updated` +
                (importReport && importReport.errors.length > 0 ? `\n\nSkipped:\n${importReport.errors.join("\n")}` : "")}
            </Text>
          </ScrollView>
        </AppDialog.ScrollArea>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => setImportReport(null)}>
            OK
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listPad: { padding: 12 },
  card: { marginVertical: 8 },
  cardTitle: { minHeight: 56 },
  cardActions: { flexDirection: "row", marginRight: 4 },
  empty: { textAlign: "center", marginTop: 24 },
  // Import dialog only: three actions side by side overflow the compact card - stack them full-width.
  stackActions: { flexDirection: "column", alignItems: "stretch", gap: 6, paddingBottom: 16 },
})
