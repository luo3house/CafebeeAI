/**
 * Global System Prompts CRUD page (rule 35): built-in "Ask" (the old Default - the fallback prompt) and "Code"
 * are pinned first as read-only rows (no menu; tapping opens the TextEditor in READ-ONLY mode - they have no
 * stored record), then custom entries from `<appRoot>/system-prompts.json`.
 * Rows show the name only (no content preview - per requirement): tapping a custom row opens the shared
 * TextEditor directly for editing; row menu = Rename / Delete; create = header [+] → name dialog → TextEditor
 * (only its save creates the entry, backing out leaves no orphan); delete asks through ConfirmDialog and relies
 * on the lazy fallback (bound conversations then just resolve to Ask).
 * Name checks: non-empty, ≤ 24 chars, unique case-insensitively (built-in names reserved); content must not be blank.
 */
import React, { useCallback, useLayoutEffect, useState } from "react"
import { FlatList, RefreshControl, StyleSheet, View } from "react-native"
import { Card, IconButton, List, Menu, TextInput } from "react-native-paper"
import { useFocusEffect } from "@react-navigation/native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { AppDialog } from "../../components/app-dialog"
import { dialogCompact } from "../../components/dialog-compact"
import { DialogButton } from "../../components/dialog-button"
import { ConfirmDialog } from "../../components/confirm-dialog"
import { AppPressable } from "../../components/app-pressable"
import { showNotice } from "../../../state/notice"
import { showToast } from "../../../state/toast"
import {
  contentNotBlank,
  isBuiltinSystemPromptId,
  kSystemPromptStore,
  SYSTEM_PROMPT_NAME_MAX,
  validatePromptName,
  type SystemPromptEntry,
} from "../../../core/system-prompts"
import { useModalInputFocus } from "../../use-modal-input-focus"
import { dialogLiftStyle, useKeyboardLift } from "../../use-keyboard-lift"

export function SystemPromptsScreen({ navigation }: { navigation: any }) {
  const insets = useSafeAreaInsets()
  const [entries, setEntries] = useState<SystemPromptEntry[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)

  const [creating, setCreating] = useState(false)
  const [createName, setCreateName] = useState("")
  const [renaming, setRenaming] = useState<SystemPromptEntry | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [deleting, setDeleting] = useState<SystemPromptEntry | null>(null)

  const refresh = useCallback(() => setEntries(kSystemPromptStore().list()), [])
  useFocusEffect(refresh)

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <IconButton
          icon="plus"
          size={22}
          onPress={() => {
            setCreateName("")
            setCreating(true)
          }}
        />
      ),
    })
  }, [navigation])

  const createInputRef = useModalInputFocus(creating)
  const renameInputRef = useModalInputFocus(renaming !== null)
  const keyboardLift = useKeyboardLift()
  const dlgStyle = dialogLiftStyle(keyboardLift)

  /** Create phase 1: lock the name first, then hand the editing over to the full-screen TextEditor (only its save creates the entry). */
  const commitCreateName = () => {
    const err = validatePromptName(createName, (lower) => kSystemPromptStore().nameTaken(lower))
    if (err) {
      showNotice(err, { title: "Invalid name" })
      return
    }
    const name = createName.trim()
    setCreating(false)
    navigation.navigate("TextEditor", {
      label: "New system prompt",
      initialText: "",
      validate: async (text: string) => contentNotBlank(text),
      onSave: async (_value: unknown, text: string) => {
        await kSystemPromptStore().create(name, text)
        showToast("Prompt saved")
        refresh()
      },
    })
  }

  /** Row tap = the editing entry point: custom rows open the editor, built-in rows (Ask/Code) open it READ-ONLY. */
  const openEntry = (entry: SystemPromptEntry) => {
    if (isBuiltinSystemPromptId(entry.id)) {
      navigation.navigate("TextEditor", {
        label: `${entry.name} (built-in)`,
        initialText: entry.content,
        readOnly: true,
      })
      return
    }
    navigation.navigate("TextEditor", {
      label: `Edit "${entry.name}"`,
      initialText: entry.content,
      validate: async (text: string) => contentNotBlank(text),
      onSave: async (_value: unknown, text: string) => {
        await kSystemPromptStore().setContent(entry.id, text)
        showToast("Prompt saved")
        refresh()
      },
    })
  }

  const commitRename = async () => {
    const target = renaming
    if (!target) return
    const err = validatePromptName(renameValue, (lower) => kSystemPromptStore().nameTaken(lower, target.id))
    if (err) {
      showNotice(err, { title: "Invalid name" })
      return
    }
    const name = renameValue.trim()
    if (name === target.name) {
      setRenaming(null)
      return
    }
    await kSystemPromptStore().rename(target.id, name)
    setRenaming(null)
    refresh()
  }

  const doDelete = async () => {
    if (!deleting) return
    await kSystemPromptStore().remove(deleting.id)
    setDeleting(null)
    showToast("Prompt deleted")
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
        renderItem={({ item }) => {
          const builtin = isBuiltinSystemPromptId(item.id)
          return (
            <AppPressable onPress={() => openEntry(item)} pressedStyle={styles.rowPressed} style={styles.rowWrap}>
              <Card style={styles.card}>
                <Card.Title
                  title={item.name}
                  titleNumberOfLines={1}
                  subtitle={builtin ? "Built-in · opens read-only" : undefined}
                  subtitleNumberOfLines={1}
                  left={(props) => <List.Icon {...props} icon="note-text-outline" />}
                  right={
                    builtin
                      ? undefined
                      : () => (
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
                        )
                  }
                />
              </Card>
            </AppPressable>
          )
        }}
      />

      <AppDialog visible={creating} onDismiss={() => setCreating(false)} style={dlgStyle}>
        <AppDialog.Title style={dialogCompact.title}>New system prompt</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <TextInput ref={createInputRef} mode="outlined" dense label={`Name (max ${SYSTEM_PROMPT_NAME_MAX})`} value={createName} onChangeText={setCreateName} />
        </AppDialog.Content>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => setCreating(false)}>Cancel</DialogButton>
          <DialogButton mode="contained" onPress={commitCreateName}>
            Next
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>

      <AppDialog visible={renaming !== null} onDismiss={() => setRenaming(null)} style={dlgStyle}>
        <AppDialog.Title style={dialogCompact.title}>Rename prompt</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <TextInput ref={renameInputRef} mode="outlined" dense label={`Name (max ${SYSTEM_PROMPT_NAME_MAX})`} value={renameValue} onChangeText={setRenameValue} />
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
        title={`Delete "${deleting?.name ?? ""}"?`}
        body="Conversations still bound to this prompt fall back to the built-in Ask automatically (their binding is left untouched)."
        confirmLabel="Delete"
        danger
        onConfirm={() => void doDelete()}
        onCancel={() => setDeleting(null)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listContent: { padding: 12 },
  rowWrap: { borderRadius: 12 },
  rowPressed: { opacity: 0.85 },
  card: { marginVertical: 4 },
  cardActions: { flexDirection: "row", alignItems: "center", marginRight: 4, paddingRight: 0 },
})
