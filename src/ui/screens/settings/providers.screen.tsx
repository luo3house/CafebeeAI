/**
 * Provider list page: add/edit/delete (deleting requires confirmation and clears project preferences
 * referencing it), plus the shared YAML transfer dialogs in the PageHeader (rule 38):
 * - Export: renders the `v1/provider` stream; secret fields carry `-- DEDUCTED --` placeholders unless the
 *   dialog's "Include secrets" checkbox opts in. Actions: Save as file (stage + File Preview, sharing happens
 *   there) / View in editor (TextEditor readOnly preview of the exact stream).
 * - Import: dialog offers "Choose file..." (document picker) or "Enter text" (full-screen TextEditor with
 *   side-effect-free precheck). The stream may carry other kinds — they count as skipped on this page.
 * Refreshes on focus (useFocusEffect): the list updates automatically after the form page saves and returns;
 * pull-to-refresh also supported.
 */
import React, { useCallback, useLayoutEffect, useState } from "react"
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native"
import { Card, IconButton, List, useTheme } from "react-native-paper"
import { useFocusEffect } from "@react-navigation/native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { kProviderRegistry, type LLMProvider } from "../../../core/providers"
import { fs } from "../../../app/app.ui.theme"
import { getProjectListIdsByPreferProvider, cleanupPreferences } from "../../../core/providers-cleanup"
import { KIND_PROVIDER } from "../../../core/transfer"
import { useYamlTransfer } from "../../components/yaml-transfer"
import { showToast } from "../../../state/toast"
import { ConfirmDialog } from "../../components/confirm-dialog"

export function ProvidersScreen({ navigation }: { navigation: any }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [deleting, setDeleting] = useState<LLMProvider | null>(null)

  const refresh = useCallback(() => setProviders(kProviderRegistry().getAll()), [])

  useFocusEffect(refresh)

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    refresh()
    setRefreshing(false)
  }, [refresh])

  const transfer = useYamlTransfer({
    navigation,
    accepted: [KIND_PROVIDER],
    filePrefix: "providers",
    noun: "providers",
    withSecrets: true,
    onApplied: refresh,
    exportDescription:
      "The registry is written as a v1/provider YAML stream. Endpoint / name / id ship as-is; the API key and every custom-header value are written as \"-- DEDUCTED --\" unless you include them.",
    importDescription:
      "Import a v1/provider YAML stream: pick an existing .yaml file, or enter the text to review it before applying. Any carried secrets go straight into encrypted storage.",
  })

  const doDelete = async () => {
    if (!deleting) return
    const affected = await getProjectListIdsByPreferProvider(deleting.id)
    await kProviderRegistry().remove(deleting.id)
    await cleanupPreferences(deleting.id, affected)
    setDeleting(null)
    showToast("Provider deleted")
    refresh()
  }

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <IconButton icon="export-variant" size={20} disabled={transfer.exporting} onPress={transfer.openExport} />
          <IconButton icon="file-import" size={20} disabled={transfer.importing} onPress={transfer.openImport} />
          <IconButton icon="plus" size={20} onPress={() => navigation.navigate("ProviderForm", { providerId: undefined })} />
        </View>
      ),
    })
  }, [navigation, transfer.exporting, transfer.importing, transfer.openExport, transfer.openImport])

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

      {transfer.dialogs}
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
})
