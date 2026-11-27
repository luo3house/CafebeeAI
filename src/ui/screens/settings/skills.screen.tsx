/**
 * Global Skills CRUD page (rule 36): plain-text snippets typed as `/name` in the chat draft; stored in
 * `<appRoot>/skills.json`, shared by every Project, reachable from the Settings page and the "+" input panel.
 * Flows mirror the System Prompts page (Rule 27/25/30): create = header [+] → name dialog → TextEditor →
 * the entry is written only on save; row menu = Rename / Edit / Delete (ConfirmDialog; messages already
 * holding expanded text are untouched - a token still sitting in a draft simply stops matching at send).
 * Name = one slash-token identifier: non-empty, `[A-Za-z0-9_-]+`, ≤ 24, unique case-insensitively; content non-blank.
 */
import React, { useCallback, useLayoutEffect, useState } from "react"
import { FlatList, RefreshControl, StyleSheet, View } from "react-native"
import { Card, IconButton, List, Menu, Text, TextInput, useTheme } from "react-native-paper"
import { useFocusEffect } from "@react-navigation/native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { fs } from "../../../app/app.ui.theme"
import { AppDialog } from "../../components/app-dialog"
import { dialogCompact } from "../../components/dialog-compact"
import { DialogButton } from "../../components/dialog-button"
import { ConfirmDialog } from "../../components/confirm-dialog"
import { useYamlTransfer } from "../../components/yaml-transfer"
import { KIND_SKILL } from "../../../core/transfer"
import { showNotice } from "../../../state/notice"
import { showToast } from "../../../state/toast"
import { contentNotBlank } from "../../../core/system-prompts"
import { kSkillStore, SKILL_NAME_MAX, validateSkillName, type SkillEntry } from "../../../core/skills"
import { useModalInputFocus } from "../../use-modal-input-focus"
import { dialogLiftStyle, useKeyboardLift } from "../../use-keyboard-lift"

function previewLine(content: string): string {
  const first = (content.split("\n")[0] ?? "").slice(0, 70)
  return content.length > first.length ? `${first}…` : first
}

export function SkillsScreen({ navigation }: { navigation: any }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [entries, setEntries] = useState<SkillEntry[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)

  const [creating, setCreating] = useState(false)
  const [createName, setCreateName] = useState("")
  const [renaming, setRenaming] = useState<SkillEntry | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [deleting, setDeleting] = useState<SkillEntry | null>(null)

  const refresh = useCallback(() => setEntries(kSkillStore().list()), [])
  useFocusEffect(refresh)

  const transfer = useYamlTransfer({
    navigation,
    accepted: [KIND_SKILL],
    filePrefix: "skills",
    noun: "skills",
    withSecrets: false,
    onApplied: refresh,
    exportDescription: "Writes one v1/skill document per skill (name + content).",
    importDescription:
      "Import v1/skill documents: pick an existing .yaml file, or enter the text to review it before applying. A skill whose name collides with a different entry is skipped and reported; names must match [A-Za-z0-9_-].",
  })

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <IconButton icon="export-variant" size={20} disabled={transfer.exporting} onPress={transfer.openExport} />
          <IconButton icon="file-import" size={20} disabled={transfer.importing} onPress={transfer.openImport} />
          <IconButton
            icon="plus"
            size={22}
            onPress={() => {
              setCreateName("")
              setCreating(true)
            }}
          />
        </View>
      ),
    })
  }, [navigation, transfer.exporting, transfer.importing, transfer.openExport, transfer.openImport])

  const createInputRef = useModalInputFocus(creating)
  const renameInputRef = useModalInputFocus(renaming !== null)
  const keyboardLift = useKeyboardLift()
  const dlgStyle = dialogLiftStyle(keyboardLift)

  const commitCreateName = () => {
    const err = validateSkillName(createName, (lower) => kSkillStore().nameTaken(lower))
    if (err) {
      showNotice(err, { title: "Invalid name" })
      return
    }
    const name = createName.trim()
    setCreating(false)
    navigation.navigate("TextEditor", {
      label: "New skill",
      initialText: "",
      validate: async (text: string) => contentNotBlank(text),
      onSave: async (_value: unknown, text: string) => {
        await kSkillStore().create(name, text)
        showToast("Skill saved")
        refresh()
      },
    })
  }

  const editContent = (entry: SkillEntry) => {
    setMenuFor(null)
    navigation.navigate("TextEditor", {
      label: `Edit "/${entry.name}"`,
      initialText: entry.content,
      validate: async (text: string) => contentNotBlank(text),
      onSave: async (_value: unknown, text: string) => {
        await kSkillStore().setContent(entry.id, text)
        showToast("Skill saved")
        refresh()
      },
    })
  }

  const commitRename = async () => {
    const target = renaming
    if (!target) return
    const err = validateSkillName(renameValue, (lower) => kSkillStore().nameTaken(lower, target.id))
    if (err) {
      showNotice(err, { title: "Invalid name" })
      return
    }
    const name = renameValue.trim()
    if (name === target.name) {
      setRenaming(null)
      return
    }
    await kSkillStore().rename(target.id, name)
    setRenaming(null)
    refresh()
  }

  const doDelete = async () => {
    if (!deleting) return
    await kSkillStore().remove(deleting.id)
    setDeleting(null)
    showToast("Skill deleted")
    refresh()
  }

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      <FlatList
        data={entries}
        keyExtractor={(e) => e.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true)
              refresh()
              setRefreshing(false)
            }}
          />
        }
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 14) }]}>
            No skills yet — tap + to create one. Type /name in the chat input to expand it.
          </Text>
        }
        renderItem={({ item }) => (
          <Card style={styles.card}>
            <Card.Title
              title={`/${item.name}`}
              titleNumberOfLines={1}
              subtitle={previewLine(item.content)}
              subtitleNumberOfLines={1}
              left={(props) => <List.Icon {...props} icon="lightning-bolt-outline" />}
              right={() => (
                <View style={styles.cardActions}>
                  <Menu
                    visible={menuFor === item.id}
                    onDismiss={() => setMenuFor(null)}
                    anchor={<IconButton icon="dots-horizontal" size={20} onPress={() => setMenuFor(item.id)} />}
                  >
                    <Menu.Item
                      title="Rename"
                      leadingIcon="rename-box"
                      onPress={() => {
                        setMenuFor(null)
                        setRenameValue(item.name)
                        setRenaming(item)
                      }}
                    />
                    <Menu.Item title="Edit content" leadingIcon="square-edit-outline" onPress={() => editContent(item)} />
                    <Menu.Item
                      title="Delete"
                      leadingIcon="delete-outline"
                      onPress={() => {
                        setMenuFor(null)
                        setDeleting(item)
                      }}
                    />
                  </Menu>
                </View>
              )}
            />
          </Card>
        )}
      />

      <AppDialog visible={creating} onDismiss={() => setCreating(false)} style={dlgStyle}>
        <AppDialog.Title style={dialogCompact.title}>New skill</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <TextInput ref={createInputRef} mode="outlined" dense label={`Slash name (letters / digits / - _, max ${SKILL_NAME_MAX})`} value={createName} onChangeText={setCreateName} autoCapitalize="none" autoCorrect={false} />
          <Text style={{ fontSize: fs(theme, 11), color: theme.colors.onSurfaceVariant, marginTop: 6 }}>
            Typing /{createName.trim() || "name"} + a space or punctuation in the chat input replaces it with the skill's text.
          </Text>
        </AppDialog.Content>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => setCreating(false)}>Cancel</DialogButton>
          <DialogButton mode="contained" onPress={commitCreateName}>
            Next
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>

      <AppDialog visible={renaming !== null} onDismiss={() => setRenaming(null)}>
        <AppDialog.Title style={dialogCompact.title}>Rename skill</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <TextInput ref={renameInputRef} mode="outlined" dense label={`Slash name (max ${SKILL_NAME_MAX})`} value={renameValue} onChangeText={setRenameValue} autoCapitalize="none" autoCorrect={false} />
        </AppDialog.Content>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => setRenaming(null)}>Cancel</DialogButton>
          <DialogButton mode="contained" onPress={() => void commitRename()}>
            Save
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>

      <ConfirmDialog
        visible={deleting !== null}
        title={`Delete "/${deleting?.name ?? ""}"?`}
        body="Already-expanded text in drafts and sent messages stays as-is; the /token simply stops matching."
        confirmLabel="Delete"
        danger
        onConfirm={() => void doDelete()}
        onCancel={() => setDeleting(null)}
      />

      {transfer.dialogs}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listContent: { padding: 12 },
  card: { marginVertical: 4 },
  cardActions: { flexDirection: "row", alignItems: "center", marginRight: 4, paddingRight: 0 },
  empty: { textAlign: "center", marginTop: 24 },
})
