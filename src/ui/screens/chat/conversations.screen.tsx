/**
 * Conversations page: lists all conversations of the current Project with create/switch/rename/system prompt/delete (CRUD).
 * Row badges for multi-session parallelism WIP (priority: Needs attention > Error > Running):
 * - Needs attention = the conversation has a pending write card awaiting approval / form awaiting fill (derived live from toolflow/formflow pending, not gated by read state);
 * - Error = the last assistant reply failed and is unread (lastAssistantId ≠ lastReadId from the UI state file;
 *   entering the conversation / sending / foreground finalization mark read and clear the badge; a background finalization failure naturally lights it up);
 * - Running = the conversation's turn is in flight (registry entry.streaming, live).
 * No cross-project aggregated hints (decision R6): after switching projects, check the pending items here yourself (current project only).
 * Tapping a row = explicit user entry (marks read); delete = release conversation (abort turn + cancel pendings + cascade-delete UI state file).
 */
import React, { useCallback, useLayoutEffect, useState } from "react"
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native"
import { Card, Icon, IconButton, List, Menu, TextInput, useTheme } from "react-native-paper"
import { fs, type MD3Theme } from "../../../app/app.ui.theme"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useFocusEffect } from "@react-navigation/native"
import { useSnapshot } from "valtio"
import { runtime } from "../../../state/runtime"
import { chatSessions, sessionKey, bindConversation, updateConversationMeta, releaseConversation } from "../../../state/chat"
import { kChatStore, type ConversationBrief, type ChatMessage } from "../../../core/chats"
import { loadProjectUiStates, type ConversationUiState } from "../../../core/ui-state"
import { toolflow } from "../../../state/toolflow"
import { formflow } from "../../../state/formflow"
import { showToast } from "../../../state/toast"
import { ConfirmDialog } from "../../components/confirm-dialog"
import { AppPressable } from "../../components/app-pressable"
import { dialogCompact } from "../../components/dialog-compact"
import { DialogButton } from "../../components/dialog-button"
import { AppDialog } from "../../components/app-dialog"
import { dialogLiftStyle, useKeyboardLift } from "../../use-keyboard-lift"
import { useModalInputFocus } from "../../use-modal-input-focus"
import type { RootStackParamList } from "../../../app/app.ui.navigator"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"

type Props = NativeStackScreenProps<RootStackParamList, "Conversations">

const formatTime = (ts: number): string => {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

type RowBadge = { icon: string; label: string; tone: "action" | "error" | "progress" } | null

export function ConversationsScreen({ navigation }: Props) {
  const theme = useTheme<MD3Theme>()
  const insets = useSafeAreaInsets()
  const snap = useSnapshot(runtime)
  const sessionsSnap = useSnapshot(chatSessions)
  const toolSnap = useSnapshot(toolflow)
  const formSnap = useSnapshot(formflow)
  const [briefs, setBriefs] = useState<ConversationBrief[]>([])
  const [uiStates, setUiStates] = useState<Record<string, ConversationUiState>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState("")
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameTitle, setRenameTitle] = useState("")
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const keyboardLift = useKeyboardLift()
  const dlgStyle = dialogLiftStyle(keyboardLift)
  const createInputRef = useModalInputFocus(creating)
  const renameInputRef = useModalInputFocus(renamingId !== null)

  const refresh = useCallback(async () => {
    const pid = snap.currentProjectId
    if (!pid) return
    const [list, ui] = await Promise.all([kChatStore().list(pid), loadProjectUiStates(pid)])
    setBriefs(list)
    setUiStates(ui)
    runtime.conversations = list.map((b) => b.conversation)
  }, [snap.currentProjectId])

  useFocusEffect(
    useCallback(() => {
      void refresh()
    }, [refresh])
  )

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }, [refresh])

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <IconButton icon="plus" size={20} onPress={() => setCreating(true)} />,
    })
  }, [navigation])

  const openConversation = async (convId: string) => {
    const pid = snap.currentProjectId
    if (!pid) return
    // Explicit entry = marks read (clears the "Error" badge; live "Needs attention/Running" are never gated)
    await bindConversation(pid, convId, { markRead: true })
    navigation.goBack()
  }

  const createConversation = async () => {
    const pid = snap.currentProjectId
    if (!pid) return
    const conv = await kChatStore().create(pid, { title: newTitle.trim() || undefined })
    setCreating(false)
    setNewTitle("")
    await bindConversation(pid, conv.id, { markRead: true })
    await refresh()
    navigation.goBack()
  }

  const confirmRename = async () => {
    const pid = snap.currentProjectId
    const target = renameTitle.trim()
    if (!pid || !renamingId || !target) {
      setRenamingId(null)
      return
    }
    await updateConversationMeta(pid, renamingId, { title: target })
    setRenamingId(null)
    await refresh()
  }

  const openSystemPrompt = (convId: string) => {
    setMenuFor(null)
    const brief = briefs.find((b) => b.conversation.id === convId)
    navigation.navigate("TextEditor", {
      label: "System Prompt",
      initialText: brief?.conversation.systemPrompt ?? "",
      onSave: async (value) => {
        const pid = snap.currentProjectId
        if (!pid) return
        await updateConversationMeta(pid, convId, { systemPrompt: String(value ?? "").trim() || undefined })
        await refresh()
        showToast("System prompt saved")
      },
    })
  }

  const confirmDelete = async () => {
    const pid = snap.currentProjectId
    if (!pid || !deletingId) return
    const removedActive = snap.currentConversationId === deletingId
    releaseConversation(pid, deletingId)
    await kChatStore().remove(pid, deletingId)
    setDeletingId(null)
    if (removedActive) {
      const list = await kChatStore().list(pid)
      if (list.length) {
        await bindConversation(pid, list[0].conversation.id, { markRead: false })
      } else {
        const conv = await kChatStore().create(pid)
        await bindConversation(pid, conv.id, { markRead: false })
      }
    }
    await refresh()
    showToast("Conversation deleted")
  }

  /** Row badge: Needs attention (live) > Error (gated by read state) > Running (live) */
  const rowBadge = (brief: ConversationBrief): RowBadge => {
    const pid = snap.currentProjectId
    const cid = brief.conversation.id
    const entry = pid ? sessionsSnap[sessionKey(pid, cid)] : undefined

    const needsAction = !!pid && (toolSnap.pending.some((p) => p.projectId === pid && p.convId === cid) || formSnap.pending.some((p) => p.projectId === pid && p.convId === cid))
    if (needsAction) return { icon: "bell-ring-outline", label: "Needs attention", tone: "action" }

    let lastAssistantId: string | null = brief.lastAssistantId
    let lastAssistantIsError = brief.lastAssistantIsError
    if (entry) {
      const msgs = entry.messages as readonly ChatMessage[]
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") {
          lastAssistantId = msgs[i].id
          lastAssistantIsError = msgs[i].state === "error"
          break
        }
      }
    }
    if (lastAssistantIsError && lastAssistantId) {
      const lastReadId = pid ? uiStates[cid]?.lastReadId ?? null : null
      if (lastAssistantId !== lastReadId) return { icon: "close-circle-outline", label: "Error", tone: "error" }
    }
    if (entry?.streaming) return { icon: "progress-clock", label: "Running", tone: "progress" }
    return null
  }

  return (
    <View style={[styles.flex, { paddingBottom: insets.bottom }]}>
      <FlatList
        data={briefs}
        keyExtractor={(b) => b.conversation.id}
        contentContainerStyle={styles.listPad}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 14) }]}>No conversations yet — tap + in the header to create one</Text>
        }
        renderItem={({ item }) => {
          const conv = item.conversation
          const active = snap.currentConversationId === conv.id
          const badge = rowBadge(item)
          const badgeColor = badge
            ? active
              ? theme.colors.onSecondaryContainer
              : badge.tone === "error"
              ? theme.colors.error
              : theme.colors.onSurfaceVariant
            : theme.colors.onSurfaceVariant
          return (
            <AppPressable accessibilityRole="button" onPress={() => openConversation(conv.id)}>
              <Card style={[styles.card, active && { backgroundColor: theme.colors.secondaryContainer }]}>
                <Card.Title
                  style={styles.cardTitle}
                  title={conv.title || "Untitled conversation"}
                  titleNumberOfLines={1}
                  titleStyle={active ? { color: theme.colors.onSecondaryContainer } : undefined}
                  subtitle={formatTime(conv.updatedAt)}
                  subtitleNumberOfLines={1}
                  subtitleStyle={active ? { color: theme.colors.onSecondaryContainer } : undefined}
                  left={(p) => <List.Icon {...p} icon="book-outline" color={active ? theme.colors.onSecondaryContainer : undefined} />}
                  right={() => (
                    <View style={styles.cardActions}>
                      {badge ? (
                        <View style={styles.badge}>
                          <Icon source={badge.icon} size={14} color={badgeColor} />
                          <Text style={[styles.badgeText, { color: badgeColor, fontSize: fs(theme, 11) }]} numberOfLines={1}>
                            {badge.label}
                          </Text>
                        </View>
                      ) : null}
                      <Menu
                        visible={menuFor === conv.id}
                        onDismiss={() => setMenuFor(null)}
                        anchor={<IconButton icon="dots-horizontal" size={20} onPress={() => setMenuFor(conv.id)} />}
                      >
                        <Menu.Item
                          title="Rename"
                          leadingIcon="pencil-outline"
                          onPress={() => {
                            setMenuFor(null)
                            setRenamingId(conv.id)
                            setRenameTitle(conv.title)
                          }}
                        />
                        <Menu.Item title="System Prompt" leadingIcon="cog-outline" onPress={() => openSystemPrompt(conv.id)} />
                        <Menu.Item
                          title="Delete"
                          leadingIcon="delete-outline"
                          onPress={() => {
                            setMenuFor(null)
                            setDeletingId(conv.id)
                          }}
                        />
                      </Menu>
                    </View>
                  )}
                />
              </Card>
            </AppPressable>
          )
        }}
      />

      <AppDialog visible={creating} onDismiss={() => setCreating(false)} style={dlgStyle}>
        <AppDialog.Title style={dialogCompact.title}>New conversation</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <TextInput ref={createInputRef} mode="outlined" dense label="Conversation title (optional)" value={newTitle} onChangeText={setNewTitle} />
        </AppDialog.Content>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => setCreating(false)}>Cancel</DialogButton>
          <DialogButton mode="contained" onPress={createConversation}>
            Create
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>

      <AppDialog visible={renamingId !== null} onDismiss={() => setRenamingId(null)} style={dlgStyle}>
        <AppDialog.Title style={dialogCompact.title}>Rename conversation</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <TextInput ref={renameInputRef} mode="outlined" dense label="Conversation name" value={renameTitle} onChangeText={setRenameTitle} />
        </AppDialog.Content>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => setRenamingId(null)}>Cancel</DialogButton>
          <DialogButton mode="contained" onPress={confirmRename}>
            Save
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>

      <ConfirmDialog
        visible={deletingId !== null}
        title="Delete conversation"
        body={
          deletingId &&
          (toolSnap.pending.some((p) => p.projectId === snap.currentProjectId && p.convId === deletingId) ||
            formSnap.pending.some((p) => p.projectId === snap.currentProjectId && p.convId === deletingId))
            ? "This conversation is waiting for your confirmation. Deleting will abort its turn and can't be undone. Delete?"
            : deletingId && sessionsSnap[sessionKey(snap.currentProjectId, deletingId)]?.streaming
            ? "This conversation is still generating. Deleting will abort its turn and can't be undone. Delete?"
            : "This can't be undone. Delete this conversation?"
        }
        confirmLabel="Delete"
        danger
        onCancel={() => setDeletingId(null)}
        onConfirm={confirmDelete}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  listPad: { padding: 12 },
  card: { marginVertical: 8 },
  cardTitle: { minHeight: 56 },
  cardActions: { flexDirection: "row", alignItems: "center", marginRight: 4, gap: 2 },
  badge: { flexDirection: "row", alignItems: "center", gap: 3, maxWidth: 92 },
  badgeText: { fontSize: 11 },
  empty: { textAlign: "center", marginTop: 24 },
})
