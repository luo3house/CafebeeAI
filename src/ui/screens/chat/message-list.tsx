/**
 * Message list FC: the ONLY component that subscribes to the bound session's `messages`.
 * ChatScreen itself never reads `.messages` (valtio affected-paths), so stream flushes no longer rebuild
 * the whole screen shell (Appbar / modelBar / input bar). Updates arrive through useSnapshotCustom:
 * JS-layer subscribe + debounce 150ms + maxWait 300ms coalescing (idle/leading and non-streaming writes
 * flush immediately via flushNow), so the JS thread stays free for typing/menu interaction during streaming.
 * renderItem identity is permanently stable: per-turn flags (lastAssistantId/streaming/humanWait) flow to
 * cells through context, so a flag flip repaints cells without rebuilding the renderItem function, and
 * unchanged cells skip via FlashList's ViewHolder memo (item reference comparison).
 * FlashList inverted is implemented via X-axis mirroring (scrollbar lands on the left): the ScrollView is
 * mirrored again and each cell content is counter-mirrored (styles.scrollMirror/cellMirror).
 */
import React, { useCallback, useContext, useMemo } from "react"
import { ScrollView, StyleSheet, Text, View, type ScrollViewProps } from "react-native"
import { useTheme } from "react-native-paper"
import { fs } from "../../../app/app.ui.theme"
import { FlashList, type FlashListRef } from "@shopify/flash-list"
import { snapshot } from "valtio"
import { chatSessions } from "../../../state/chat"
import type { ChatMessage } from "../../../core/chats"
import { MessageBubble, type MessageBubbleCallbacks } from "../../components/message-bubble"
import { useSnapshotCustom } from "../../use-snapshot-custom"

const mirrorTransformStyle = { transform: [{ scaleX: -1 }] }

/** X-axis mirrored inner ScrollView: pulls the scrollbar FlashList inverted mirrors to the left back to the right */
function MirroredScrollComponent(props: ScrollViewProps) {
  return <ScrollView {...props} style={mirrorTransformStyle} />
}

function ChatListEmpty() {
  const theme = useTheme()
  return (
    // FlashList applies one mirror compensation around ListEmptyComponent; after the ScrollView-body mirror it must be cancelled here
    <View style={styles.cellMirror}>
      <View style={{ marginTop: 60 }}>
        <Text style={{ textAlign: "center", color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 14) }}>Start a conversation</Text>
      </View>
    </View>
  )
}

const EMPTY_MESSAGES: ChatMessage[] = []

const keyExtractor = (m: ChatMessage) => m.id

interface MessageCellFlags {
  lastAssistantId: string
  streaming: boolean
  humanWait: boolean
  callbacks: MessageBubbleCallbacks
}

const CellFlagsContext = React.createContext<MessageCellFlags | null>(null)

/** Cell wrapper: reads the per-turn flags from context so renderItem itself stays a stable identity forever */
function MessageCell({ item }: { item: ChatMessage }) {
  const flags = useContext(CellFlagsContext)
  if (!flags) return null
  return (
    <View style={styles.cellMirror}>
      <MessageBubble
        message={item}
        isLastAssistant={item.id === flags.lastAssistantId && !flags.streaming}
        interactive={item.id === flags.lastAssistantId}
        waitingHuman={flags.humanWait && item.id === flags.lastAssistantId}
        callbacks={flags.callbacks}
      />
    </View>
  )
}

type MessageListProps = {
  /** sessionKey(projectId, convId) of the bound session; ChatScreen re-keys this component on change */
  boundSessionKey: string
  streaming: boolean
  humanWait: boolean
  callbacks: MessageBubbleCallbacks
  /** shared ref: ChatScreen's scrollToLatest(Delayed) drives the list position from outside */
  listRef: React.RefObject<FlashListRef<ChatMessage> | null>
}

export function MessageList({ boundSessionKey, streaming, humanWait, callbacks, listRef }: MessageListProps) {
  const messages = useSnapshotCustom<ChatMessage[]>(
    chatSessions,
    () => {
      const entry = chatSessions[boundSessionKey]
      if (!entry) return EMPTY_MESSAGES
      return snapshot(entry.messages) as unknown as ChatMessage[]
    },
    {
      // not mid-stream (turn end / delete / regenerate / first paint) = show immediately
      flushNow: () => !chatSessions[boundSessionKey]?.streaming,
    }
  )

  const dataForList = useMemo(() => messages.slice().reverse(), [messages])

  const lastAssistantId = useMemo(() => {
    const last = messages[messages.length - 1]
    return last && last.role === "assistant" ? last.id : ""
  }, [messages])

  const flags = useMemo<MessageCellFlags>(
    () => ({ lastAssistantId, streaming, humanWait, callbacks }),
    [lastAssistantId, streaming, humanWait, callbacks]
  )

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => <MessageCell item={item} />,
    []
  )

  return (
    <CellFlagsContext.Provider value={flags}>
      <FlashList
        ref={listRef}
        data={dataForList}
        nestedScrollEnabled
        inverted
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        renderScrollComponent={MirroredScrollComponent}
        ListEmptyComponent={ChatListEmpty}
        contentContainerStyle={styles.listPad}
      />
    </CellFlagsContext.Provider>
  )
}

const styles = StyleSheet.create({
  listPad: { paddingVertical: 8 },
  cellMirror: mirrorTransformStyle,
})
