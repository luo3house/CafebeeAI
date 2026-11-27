/**
 * Main chat screen: custom Appbar + FlashList(inverted) message list + input bar + "+" panel below the input.
 * All conversation state comes from the bound session's entry in the registry (state/chat): switching conversations never interrupts
 * running turns of any other session; while multi-session parallelism is WIP this page is just the view of "the session being watched".
 * Draft lives in entry.draft mirrored to the low-frequency draftStore slice (rendered by ChatInputBar with
 * {sync:true}, debounced to disk separately); sending is blocked while network streaming (input bar gate),
 * and while waiting on a human (card/form) sending = preempt this session's turn.
 * List updates are localized: this component never reads `entry.messages` (valtio tracks affected paths),
 * so stream flushes re-render only the MessageList FC (throttled snapshot) and the streaming cell inside
 * it - the Appbar/modelBar/input bar shell does not rebuild per flush. renderItem lives in message-list.tsx
 * with a permanently stable identity; per-turn flags reach cells via context.
 * FlashList inverted + the double mirroring workaround live in message-list.tsx.
 * System Prompt quick switch (rule 35): the input-bar button opens SystemPromptPicker (pick = sticky binding write,
 * next turn only); Skills (rule 36): keystroke expansion runs in onChangeDraft via expandSkillsOnEdit (the send
 * sweep lives in llm/chat.ts) and the debounced candidate strip is a self-subscribed FC rendered above the input.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { StyleSheet, Text, View, KeyboardAvoidingView, Platform, Clipboard, Keyboard, AppState } from "react-native"
import { Appbar, IconButton, ActivityIndicator, TextInput, useTheme } from "react-native-paper"
import { fs, type MD3Theme } from "../../../app/app.ui.theme"
import type { FlashListRef } from "@shopify/flash-list"
import { DrawerActions } from "@react-navigation/native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useSnapshot } from "valtio"
import { runtime } from "../../../state/runtime"
import { chatSessions, sessionKey, getEntry, bindConversation, setDraft, updateConversationMeta, persistNow } from "../../../state/chat"
import { kChatStore, type ChatMessage } from "../../../core/chats"
import { kProviderRegistry } from "../../../core/providers"
import { loadConfig } from "../../../core/config"
import {
  sendUserMessage,
  stopStreaming,
  regenerateLastAssistant,
  setConversationModel,
} from "../../../llm/chat"
import { openModelPicker } from "../../../state/modelpicker"
import { formflow } from "../../../state/formflow"
import { toolflow } from "../../../state/toolflow"
import { openAnswerViewer } from "../../../state/answer"
import type { MessageBubbleCallbacks } from "../../components/message-bubble"
import { AppPressable } from "../../components/app-pressable"
import { dialogCompact } from "../../components/dialog-compact"
import { DialogButton } from "../../components/dialog-button"
import { AppDialog } from "../../components/app-dialog"
import { ChatInputBar } from "./chat-input-bar"
import { MessageList } from "./message-list"
import { InputMorePanel, type InputMoreItem } from "./input-more-panel"
import { StreamIndicator } from "./stream-indicator"
import { exportConversationPairMarkdown } from "../../../core/import-export"
import { showToast } from "../../../state/toast"
import { showNotice } from "../../../state/notice"
import { dialogLiftStyle, useKeyboardLift } from "../../use-keyboard-lift"
import { useModalInputFocus } from "../../use-modal-input-focus"
import { kApp } from "../../../app/app"
import { kSystemPromptStore, SYSTEM_PROMPT_ASK_ID } from "../../../core/system-prompts"
import { completeTrailingSlash } from "../../../core/skills"
import { consumeInitialNotificationTap, onNotificationTap, syncVisibleConversation } from "../../../state/notifications"
import { openNotificationTarget } from "../../../state/notification-nav"
import { SystemPromptPicker } from "./system-prompt-picker"
import { SkillHintStrip } from "./skill-hint-strip"
import type { AppNavigation } from "../../../app/app.ui.navigator"

type NavProps = { navigation: AppNavigation }

/** Conversation title cap shown in the header (over-length truncated with ellipsis) */
const HEADER_TITLE_MAX_CHARS = 8

function truncateConversationTitle(title?: string): string {
  const t = title?.trim() || "Untitled conversation"
  return t.length > HEADER_TITLE_MAX_CHARS ? `${t.slice(0, HEADER_TITLE_MAX_CHARS)}…` : t
}

export function ChatScreen({ navigation }: NavProps) {
  const theme = useTheme<MD3Theme>()
  const insets = useSafeAreaInsets()
  const snap = useSnapshot(runtime)
  const sessionsSnap = useSnapshot(chatSessions)
  const [moreVisible, setMoreVisible] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameText, setRenameText] = useState("")
  const [modelLabel, setModelLabel] = useState<string>("…")
  const [appReady, setAppReady] = useState(false)
  const [promptPickerVisible, setPromptPickerVisible] = useState(false)
  // the prompt registry is non-reactive: bump on focus so the modelBar prompt name re-reads after CRUD edits
  const [promptTick, setPromptTick] = useState(0)

  const projectId = snap.currentProjectId
  const convId = snap.currentConversationId
  const boundSessionKey = convId ? sessionKey(projectId, convId) : ""
  const sessionSnap = boundSessionKey ? sessionsSnap[boundSessionKey] : undefined
  const conversation = sessionSnap?.conversation ?? null
  // NOTE: never read sessionSnap?.messages / .draft here - this component must not re-render on stream
  // flushes; MessageList subscribes to messages (throttled) and ChatInputBar to draftStore instead.
  const streaming = !!sessionSnap?.streaming

  // Effective system-prompt binding (rule 35): unbound OR an id pointing at a deleted custom entry both resolve
  // to the built-in Ask (lazy fallback, nothing rewritten); the picker highlights that id. modelBar shows the
  // name for anything non-Ask (built-in Code included).
  const boundPromptId = useMemo(() => {
    const id = conversation?.systemPromptId
    if (!id) return SYSTEM_PROMPT_ASK_ID
    return kSystemPromptStore().get(id) ? id : SYSTEM_PROMPT_ASK_ID
    // promptTick: the registry is not valtio - bump on re-focus (CRUD renames) recomputes the name too
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.systemPromptId, promptTick])
  const promptName = kSystemPromptStore().get(boundPromptId)?.name ?? "Ask"
  const boundPromptName = boundPromptId === SYSTEM_PROMPT_ASK_ID ? "" : promptName
  // Roundel content for the input-bar quick-switch button (rule 35) = the bound name's first character/letter (uppercased for latin)
  const promptInitial = Array.from(promptName.trim())[0]?.toUpperCase() ?? "?"

  // Waiting on a human (this session's pending card / form to fill): input-bar send = preempt, indicator hidden (the card is the status)
  const toolSnap = useSnapshot(toolflow)
  const formSnap = useSnapshot(formflow)
  const humanWait = useMemo(
    () =>
      !!convId &&
      (formSnap.pending.some((p) => p.projectId === projectId && p.convId === convId) ||
        toolSnap.pending.some((p) => p.projectId === projectId && p.convId === convId)),
    [projectId, convId, formSnap.pending, toolSnap.pending]
  )

  const listRef = useRef<FlashListRef<ChatMessage>>(null)
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Scroll to the latest message (inverted + reversed data: index 0/offset 0 is the newest); wait one frame so the new data commits before scrolling, no animation. An immediate jump cancels any pending delayed jump */
  const scrollToLatest = useCallback(() => {
    if (scrollTimerRef.current) {
      clearTimeout(scrollTimerRef.current)
      scrollTimerRef.current = null
    }
    requestAnimationFrame(() => {
      listRef.current?.scrollToOffset({ offset: 0, animated: false })
    })
  }, [])
  /** For send/regenerate: debounce 500ms before pulling to latest — the user record and the AI placeholder bubble insert in quick succession, avoiding two abrupt list jumps at that moment */
  const scrollToLatestDelayed = useCallback(() => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current)
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null
      requestAnimationFrame(() => {
        listRef.current?.scrollToOffset({ offset: 0, animated: false })
      })
    }, 500)
  }, [])
  useEffect(
    () => () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current)
    },
    []
  )

  const collapseMore = useCallback(() => setMoreVisible(false), [])
  const openConversationSwitcher = useCallback(() => {
    setMoreVisible(false)
    navigation.navigate("Conversations")
  }, [navigation])
  const openRename = useCallback(() => {
    setMoreVisible(false)
    setRenameText(getEntry(runtime.currentProjectId, runtime.currentConversationId)?.conversation.title ?? "")
    setRenaming(true)
  }, [])
  const keyboardLift = useKeyboardLift(collapseMore)
  const dlgStyle = dialogLiftStyle(keyboardLift)
  const renameInputRef = useModalInputFocus(renaming)

  useEffect(() => {
    kApp().ready.then(() => setAppReady(true))
  }, [])

  useEffect(() => {
    if (!appReady || !projectId) return
    void (async () => {
      // Cold-start notification tap: open its project/conversation (explicit entry → markRead) before the
      // normal landing binding; a deleted target simply falls through to the standard landing below.
      const tap = await consumeInitialNotificationTap()
      if (tap) await openNotificationTarget(tap)
      const pid = runtime.currentProjectId
      const briefs = await kChatStore().list(pid)
      if (runtime.currentProjectId !== pid) return // race guard: project switched during await
      let target = runtime.currentConversationId
      if (!target || !briefs.some((b) => b.conversation.id === target)) {
        if (!briefs.length) {
          const created = await kChatStore().create(pid)
          target = created.id
        } else {
          target = briefs[0].conversation.id
        }
      }
      if (runtime.currentProjectId !== pid) return // create may also yield at await; validate once more before binding
      // Programmatic auto-binding never marks read (project-switch/cold-start landings swallow no badges, R8 decision)
      await bindConversation(pid, target, { markRead: false })
      void refreshConversations(pid)
      void refreshLabel()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appReady, projectId, snap.currentConversationId])

  // Warm notification taps (app alive): the native module emits one event per notification tap
  useEffect(() => onNotificationTap((tap) => void openNotificationTarget(tap)), [])

  // Returning to the app while the chat page is actually the visible screen → the bound conversation's
  // leftover notification is stale (resuming on a pushed screen keeps it: the user is not looking at the chat)
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && navigation.isFocused()) syncVisibleConversation()
    })
    return () => sub.remove()
  }, [navigation])

  const refreshConversations = async (pid: string) => {
    const briefs = await kChatStore().list(pid)
    if (runtime.currentProjectId !== pid) return
    runtime.conversations = briefs.map((b) => b.conversation)
  }

  /** Session-level binding first, fall back to project preference (same order as resolveSendTarget) */
  const refreshLabel = async () => {
    const pid = runtime.currentProjectId
    const cid = runtime.currentConversationId
    const entry = getEntry(pid, cid)
    if (!entry) {
      setModelLabel("…")
      return
    }
    const conv = entry.conversation
    const boundProvider = conv.providerId ? kProviderRegistry().getById(conv.providerId) : undefined
    if (boundProvider) {
      setModelLabel(conv.model ? `${boundProvider.name} / ${conv.model}` : `${boundProvider.name} / No model`)
      return
    }
    try {
      const cfg = await loadConfig(pid)
      const p = cfg.spec.prefer_provider ? kProviderRegistry().getById(cfg.spec.prefer_provider) : undefined
      setModelLabel(p ? (cfg.spec.prefer_model ? `${p.name} / ${cfg.spec.prefer_model}` : `${p.name} / No model`) : "No Provider configured")
    } catch {
      setModelLabel("…")
    }
  }

  useEffect(() => {
    // After returning from ModelPicker, sync the provider/model label in the bar (including picks made before sending); returning to the chat page keeps the original scroll position — no scrolling
    return navigation.addListener("focus", () => {
      void refreshLabel()
      setPromptTick((t) => t + 1) // return from the System Prompts CRUD page: re-read the registry name for the hint/picker
      syncVisibleConversation() // the bound conversation is on screen → its notification (if any) is stale
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // After switching / first binding a conversation, jump to the latest message
    scrollToLatest()
  }, [conversation?.id, scrollToLatest])

  const onChangeDraft = useCallback((t: string) => {
    const entry = getEntry(runtime.currentProjectId, runtime.currentConversationId)
    if (!entry) return
    // rule 36: the draft always holds the raw text - slash-skill expansion happens only at send time (llm/chat.ts)
    setDraft(entry, t)
  }, [])

  // rule 36 candidate-pill tap: replace the trailing in-progress token with the canonical `/<name> ` (the trailing
  // space is the submit-marker); the body is never pasted into the draft - expansion happens at send time only
  const onCompleteSkill = useCallback((name: string) => {
    const entry = getEntry(runtime.currentProjectId, runtime.currentConversationId)
    if (!entry) return
    const next = completeTrailingSlash(entry.draft, name)
    if (next !== null) setDraft(entry, next)
  }, [])

  const openModelSwitcher = async () => {
    setMoreVisible(false)
    const cid = runtime.currentConversationId
    const entry = getEntry(projectId, cid)
    if (!entry) return
    if (kProviderRegistry().getAll().length === 0) {
      showNotice("Configure a Provider first", { title: "No Provider" })
      navigation.navigate("Providers")
      return
    }
    const conv = entry.conversation
    const current = conv.providerId ? kProviderRegistry().getById(conv.providerId) ?? null : null
    // Open the dedicated picker page (openModelPicker navigates to ModelPicker internally; returns here after a choice)
    const picked = await openModelPicker({ purpose: "manual", provider: current })
    if (!picked) return
    const idx = picked.indexOf("\u0001")
    if (idx === -1) return
    const provider = kProviderRegistry().getById(picked.slice(0, idx))
    const model = picked.slice(idx + 1)
    if (!provider || !model) {
      showNotice("The selected Provider is no longer available", { title: "Provider unavailable" })
      return
    }
    // Sticky write of the session binding (project-preference default follows along); affects only the next turn, never interrupts a running one
    await setConversationModel(projectId, conv.id, provider.id, model)
    setModelLabel(`${provider.name} / ${model}`)
    showToast(`Switched: ${provider.name} / ${model}`)
  }

  const doRenameConversation = async () => {
    const entry = getEntry(runtime.currentProjectId, runtime.currentConversationId)
    if (!entry) return
    const target = renameText.trim()
    if (!target) {
      showNotice("Conversation name cannot be empty", { title: "Invalid name" })
      return
    }
    if (target === entry.conversation.title) {
      setRenaming(false)
      return
    }
    try {
      await updateConversationMeta(entry.projectId, entry.convId, { title: target })
      setRenaming(false)
      await refreshConversations(entry.projectId)
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Rename failed" })
    }
  }

  /** Quick switch (rule 35): sticky write of the conversation binding - built-in Ask/Code included (the unbound state is equivalent to Ask), affects only the next turn, never interrupts a running one */
  const pickSystemPrompt = (id: string) => {
    setPromptPickerVisible(false)
    if (!projectId || !convId) return
    if (boundPromptId === id) return
    updateConversationMeta(projectId, convId, { systemPromptId: id }).catch((err: any) =>
      showNotice(String(err?.message ?? err), { title: "Update failed" })
    )
  }

  const moreItems: InputMoreItem[] = [
    {
      key: "files",
      icon: "folder-multiple-outline",
      label: "Files",
      onPress: () => {
        setMoreVisible(false)
        navigation.navigate("ProjectFiles")
      },
    },
    { key: "models", icon: "chip", label: "Models", onPress: () => void openModelSwitcher() },
    {
      key: "skills",
      icon: "lightning-bolt-outline",
      label: "Skills",
      onPress: () => {
        setMoreVisible(false)
        navigation.navigate("Skills")
      },
    },
    {
      key: "file-server",
      icon: "wifi",
      label: "File Server",
      onPress: () => {
        setMoreVisible(false)
        navigation.navigate("StaticFs", { projectId })
      },
    },
    {
      key: "git",
      icon: "source-branch",
      label: "Git",
      onPress: () => {
        setMoreVisible(false)
        navigation.navigate("GitControl", { projectId })
      },
    },
  ]

  const onSend = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || !projectId || !convId) return
    if (streaming && !humanWait) return
    const entry = getEntry(projectId, convId)
    if (!entry) return
    setMoreVisible(false)
    setDraft(entry, "")
    try { Keyboard.dismiss() } catch {}
    try {
      const turn = sendUserMessage(projectId, convId, trimmed)
      scrollToLatestDelayed()
      await turn
      await refreshConversations(projectId)
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Send failed" })
    }
  }

  const onStop = () => {
    if (projectId && convId) stopStreaming(projectId, convId)
  }

  /** Stable callbacks: read fresh from the raw entry inside (never close over messages/snapshot), so MessageBubble memo holds */
  const callbacks = useMemo<MessageBubbleCallbacks>(
    () => ({
      onCopyText: (text) => {
        Clipboard.setString(text)
        showToast("Copied")
      },
      onOpenFull: (messageId) => {
        const entry = getEntry(runtime.currentProjectId, runtime.currentConversationId)
        if (!entry) return
        const msg = (entry.messages as ChatMessage[]).find((m) => m.id === messageId)
        if (!msg) return
        const md = msg.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { text?: string }).text ?? "")
          .join("\n")
        if (!md.trim()) return
        openAnswerViewer(md, truncateConversationTitle(entry.conversation.title))
        navigation.navigate("AnswerFull")
      },
      onExportPair: async (messageId) => {
        const entry = getEntry(runtime.currentProjectId, runtime.currentConversationId)
        if (!entry) return
        const msgs = entry.messages as ChatMessage[]
        let userIdx = msgs.findIndex((m) => m.id === messageId)
        if (userIdx === -1) return
        while (userIdx >= 0 && msgs[userIdx].role !== "user") userIdx--
        if (userIdx < 0) return
        try {
          await exportConversationPairMarkdown(entry.projectId, entry.conversation, userIdx)
        } catch (err: any) {
          showNotice(String(err?.message ?? err), { title: "Export failed" })
        }
      },
      onRegenerate: async () => {
        const entry = getEntry(runtime.currentProjectId, runtime.currentConversationId)
        if (!entry || entry.streaming) return // cannot regenerate while in flight (incl. waiting on a human): resolve the card first or preempt by sending
        try {
          const turn = regenerateLastAssistant(entry.projectId, entry.convId)
          scrollToLatestDelayed()
          await turn
        } catch (err: any) {
          showNotice(String(err?.message ?? err), { title: "Regenerate failed" })
        }
      },
      onDeleteMessage: async (messageId) => {
        const entry = getEntry(runtime.currentProjectId, runtime.currentConversationId)
        if (!entry) return
        const msgs = entry.messages as ChatMessage[]
        const idx = msgs.findIndex((m) => m.id === messageId)
        if (idx === -1) return
        let dropEnd = idx
        for (let i = idx + 1; i < msgs.length; i++) {
          if (msgs[i].role === "assistant") dropEnd = i
          else break
        }
        const next = msgs.slice()
        next.splice(idx, dropEnd - idx + 1)
        entry.messages = next
        await persistNow(entry)
      },
    }),
    [scrollToLatestDelayed, navigation]
  )

  if (!appReady) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    )
  }

  const displayTitle = truncateConversationTitle(conversation?.title)

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Appbar.Header mode="small" style={{ elevation: 0 }}>
        <Appbar.Action icon="menu" onPress={() => navigation.dispatch(DrawerActions.openDrawer())} />
        <Appbar.Content
          style={styles.titleCenter}
          title={
            <View style={styles.titleRow}>
              <Text style={[styles.titleText, { color: theme.colors.onSurface, fontSize: fs(theme, 16) }]} numberOfLines={1} onPress={openConversationSwitcher}>
                {displayTitle}
              </Text>
              <IconButton icon="pencil-outline" size={18} style={styles.titleEdit} onPress={openRename} />
            </View>
          }
        />
        <View style={styles.headerSwitch}>
          <Appbar.Action icon="format-list-bulleted" onPress={openConversationSwitcher} />
        </View>
      </Appbar.Header>

      <AppPressable style={styles.modelBarTouch} onPress={() => void openModelSwitcher()}>
        <View style={styles.modelBar}>
          <Text style={[styles.modelText, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 11) }]} numberOfLines={1}>
            {modelLabel}
          </Text>
          <IconButton icon="cog-outline" size={14} style={styles.modelCog} onPress={openModelSwitcher} />
          <Text style={[styles.convHint, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 11) }]} onPress={openConversationSwitcher}>
            {boundPromptName}
          </Text>
        </View>
      </AppPressable>

      <MessageList
        key={boundSessionKey || "none"}
        boundSessionKey={boundSessionKey}
        streaming={streaming}
        humanWait={humanWait}
        callbacks={callbacks}
        listRef={listRef}
      />

      <SkillHintStrip draftKey={boundSessionKey} onComplete={onCompleteSkill} />

      <View style={[styles.inputWrap, { marginBottom: keyboardLift, paddingBottom: insets.bottom }]}>
        <View pointerEvents="none" style={styles.indicatorFloat}>
          <StreamIndicator streaming={streaming} humanWait={humanWait} />
        </View>
        <ChatInputBar
          key={convId ?? "none"}
          draftKey={boundSessionKey}
          onChangeText={onChangeDraft}
          streaming={streaming}
          humanWait={humanWait}
          moreVisible={moreVisible}
          onToggleMore={() => {
            Keyboard.dismiss()
            setMoreVisible((v) => !v)
          }}
          onPickPrompt={() => {
            try { Keyboard.dismiss() } catch {}
            setPromptPickerVisible(true)
          }}
          promptInitial={promptInitial}
          onSend={onSend}
          onStop={onStop}
        />
        {moreVisible ? <InputMorePanel items={moreItems} /> : null}
      </View>

      <AppDialog visible={renaming} onDismiss={() => setRenaming(false)} style={dlgStyle}>
        <AppDialog.Title style={dialogCompact.title}>Rename conversation</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <TextInput ref={renameInputRef} mode="outlined" dense label="Conversation name" value={renameText} onChangeText={setRenameText} />
        </AppDialog.Content>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => setRenaming(false)}>
            Cancel
          </DialogButton>
          <DialogButton mode="contained" onPress={doRenameConversation}>
            Save
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>

      <SystemPromptPicker
        visible={promptPickerVisible}
        currentId={boundPromptId}
        onDismiss={() => setPromptPickerVisible(false)}
        onPick={pickSystemPrompt}
        onManage={() => {
          setPromptPickerVisible(false)
          navigation.navigate("SystemPrompts")
        }}
      />
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  titleCenter: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "70%",
  },
  titleText: { fontSize: 16, fontWeight: "700", flexShrink: 1 },
  titleEdit: { margin: 0, padding: 0 },
  headerSwitch: {
    position: "absolute",
    right: 2,
    top: 0,
    bottom: 0,
    justifyContent: "center",
  },
  modelBarTouch: { width: "100%" },
  modelBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 2,
  },
  modelText: { fontSize: 11, flex: 1 },
  modelCog: { margin: 0, padding: 0 },
  convHint: { fontSize: 11 },
  inputWrap: { width: "100%" },
  indicatorFloat: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: "100%",
    marginBottom: 8,
  },
})
