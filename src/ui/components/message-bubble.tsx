/**
 * Message row: user questions are drawn as bubbles (no right-side avatar slot, long-press the bubble to open the menu);
 * assistant replies use article typography (no bubble background/padding, no AI avatar), keeping the same row-padding
 * baseline as user bubbles (never hugging the screen edge).
 * Tool-call cards / reasoning blocks / body text / footer all align on the same side without indentation.
 * Block elements (codeblocks/tables etc.) shrink to tool-card-level font size/padding via MarkdownBlock compact.
 * Footer row at the bottom of the article (the whole AppPressable row = the menu entry, gear cog-outline 14 to the
 * left of the small (11) "Reply complete" text); the body text area responds to no taps (avoids fighting text
 * selection/scrolling), the menu is opened only through the footer row.
 * The footer is not rendered while streaming over the network / executing tools (that row is reserved for future
 * tok/s, counters and similar information); while waiting on a human it presents as "Reply complete" (no
 * "Generating…" badge — the pending-confirmation/pending-form card is itself the status).
 * The user menu uses Menu coordinate anchoring (the long-press point pageX/pageY; the Portal is unaffected by the
 * FlashList inverted mirror).
 * All Markdown on the chat page has selectable disabled: user bubbles so the long press isn't hijacked by text
 * selection, assistant text selection happens uniformly on the "Expand answer" full page (AnswerFull).
 */
import React, { useMemo, useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import { useTheme, Icon, Menu } from "react-native-paper"
import { fs } from "../../app/app.ui.theme"
import type { ChatMessage, MessagePart } from "../../core/chats"
import { MarkdownBlock } from "./markdown"
import { ReasoningBlock } from "./reasoning-block"
import { ToolCard } from "./tool-card"
import { AppPressable } from "./app-pressable"

export interface MessageBubbleCallbacks {
  onCopyText: (text: string) => void
  onOpenFull: (messageId: string) => void
  onExportPair: (messageId: string) => void
  onRegenerate: () => void
  onDeleteMessage: (messageId: string) => void
}

export const MessageBubble = React.memo(function MessageBubble({
  message,
  isLastAssistant,
  interactive = true,
  waitingHuman = false,
  callbacks,
}: {
  message: ChatMessage
  isLastAssistant: boolean
  /** Whether this is the newest message: pending-confirmation tool cards show their action buttons only on the newest record */
  interactive?: boolean
  /** Waiting on a human (card pending confirmation / form pending fill): the badge presents as "Reply complete" instead of "Generating…", and the input bar always stays in send state */
  waitingHuman?: boolean
  callbacks: MessageBubbleCallbacks
}) {
  const theme = useTheme()
  const [menuVisible, setMenuVisible] = useState(false)
  const [anchorPos, setAnchorPos] = useState<{ x: number; y: number } | null>(null)

  const textContent = useMemo(() => {
    return message.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join("\n")
  }, [message.parts])

  const isUser = message.role === "user"

  const renderParts = (part: MessagePart, idx: number) => {
    if (part.type === "text") {
      return (
        <View key={idx}>
          {/* No long-press text selection on the chat page (user bubbles make room for the long-press menu; assistant selection happens uniformly on the "Expand answer" full page) */}
          <MarkdownBlock
            content={part.text ?? ""}
            compact={!isUser}
            selectable={false}
            lineHeightScale={1.5}
            color={isUser ? theme.colors.onPrimaryContainer : theme.colors.onSurface}
          />
        </View>
      )
    }
    if (part.type === "attachment") {
      return (
        <View key={idx} style={[styles.attachment, { backgroundColor: theme.colors.surfaceVariant }]}>
          <View style={styles.inlineRow}>
            <Icon source="paperclip" size={14} color={theme.colors.onSurfaceVariant} />
            <Text style={{ color: theme.colors.onSurfaceVariant, fontWeight: "600", fontSize: fs(theme, 14) }}>{part.name}</Text>
          </View>
          {part.truncated ? <Text style={{ color: theme.colors.error, fontSize: fs(theme, 12) }}>(Content too long and was truncated)</Text> : null}
        </View>
      )
    }
    if (part.type === "reasoning") {
      return <ReasoningBlock key={idx} text={part.text ?? ""} />
    }
    if (part.type === "tool_call") {
      return <ToolCard key={idx} part={part} interactive={interactive} />
    }
    return null
  }

  const statusBadge = () => {
    if (!isUser && message.state === "streaming" && !waitingHuman) {
      return (
        <View style={[styles.inlineRow, { marginTop: 4 }]}>
          <Icon source="progress-clock" size={14} color={theme.colors.onSurfaceVariant} />
          <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }}>Generating…</Text>
        </View>
      )
    }
    if (!isUser && message.state === "stopped") {
      return (
        <View style={[styles.inlineRow, { marginTop: 4 }]}>
          <Icon source="alert-outline" size={14} color={theme.colors.error} />
          <Text style={{ color: theme.colors.error, fontSize: fs(theme, 12) }}>{message.error ?? "Interrupted by user"}</Text>
        </View>
      )
    }
    if (!isUser && message.state === "error") {
      return (
        <View style={{ marginTop: 6 }}>
          <Text style={{ color: theme.colors.error, fontSize: fs(theme, 13) }}>Generation failed: {message.error}</Text>
        </View>
      )
    }
    return null
  }

  const menu = useMemo(() => {
    const items: React.ReactNode[] = []
    if (textContent) {
      items.push(
        <Menu.Item
          key="copy"
          title="Copy text"
          leadingIcon="content-copy"
          onPress={() => {
            setMenuVisible(false)
            callbacks.onCopyText(textContent)
          }}
        />
      )
    }
    if (!isUser) {
      if (textContent) {
        items.push(
          <Menu.Item
            key="expand"
            title="Expand answer"
            leadingIcon="page-layout-body"
            onPress={() => {
              setMenuVisible(false)
              callbacks.onOpenFull(message.id)
            }}
          />
        )
      }
      items.push(
        <Menu.Item
          key="export"
          title="Export this Q&A"
          leadingIcon="export-variant"
          onPress={() => {
            setMenuVisible(false)
            callbacks.onExportPair(message.id)
          }}
        />
      )
      if (isLastAssistant) {
        items.push(
          <Menu.Item
            key="regenerate"
            title="Regenerate"
            leadingIcon="refresh"
            onPress={() => {
              setMenuVisible(false)
              callbacks.onRegenerate()
            }}
          />
        )
      }
    }
    items.push(
      <Menu.Item
        key="delete"
        title="Delete message"
        leadingIcon="delete-outline"
        titleStyle={{ color: theme.colors.error }}
        onPress={() => {
          setMenuVisible(false)
          callbacks.onDeleteMessage(message.id)
        }}
      />
    )
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textContent, isUser, isLastAssistant, message.id, callbacks, theme.colors.error])

  // Assistant footer row at the bottom of the article (no indentation, hugging the left): the whole row (gear + "Reply complete") is the menu entry, inline whitespace also responds to taps;
  // not rendered while streaming over the network / executing tools, and rendered as "Reply complete" while waiting on a human (the card is the status); tok/s, counters etc. may be added here in the future.
  const assistantFooter =
    !isUser && (message.state !== "streaming" || waitingHuman) ? (
      <Menu
        visible={menuVisible}
        onDismiss={() => setMenuVisible(false)}
        anchor={
          <AppPressable style={styles.footerTouch} hoverOpacity={0.6} onPress={() => setMenuVisible(true)}>
            <View style={[styles.inlineRow, styles.footer]}>
              <Icon source="cog-outline" size={14} color={theme.colors.onSurfaceVariant} />
              {(message.state === "done" || message.state === undefined || waitingHuman) && <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 11) }}>Reply complete</Text>}
            </View>
          </AppPressable>
        }
        contentStyle={{ borderRadius: 8 }}
      >
        {menu}
      </Menu>
    ) : null

  const content = (
    <>
      {message.parts.map(renderParts)}
      {statusBadge()}
      {assistantFooter}
    </>
  )

  const userBubble = (
    <AppPressable
      style={[
        styles.bubbleWrap,
        {
          backgroundColor: theme.colors.primaryContainer,
          borderBottomRightRadius: 6,
          borderBottomLeftRadius: 16,
        },
      ]}
      onLongPress={(e) => {
        setAnchorPos({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })
        setMenuVisible(true)
      }}
    >
      {content}
    </AppPressable>
  )

  // User menu: coordinate anchor (the long-press point); the Menu's inline part renders at 0 size and takes no row space
  const userMenu = (
    <Menu visible={menuVisible} onDismiss={() => setMenuVisible(false)} anchor={anchorPos ?? { x: 0, y: 0 }} contentStyle={{ borderRadius: 8 }}>
      {menu}
    </Menu>
  )

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      {isUser ? userBubble : <View style={styles.article}>{content}</View>}
      {isUser ? userMenu : null}
    </View>
  )
})

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  rowUser: {
    justifyContent: "flex-end",
  },
  rowAssistant: {
    justifyContent: "flex-start",
  },
  bubbleWrap: {
    maxWidth: "82%",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
  },
  article: {
    flex: 1,
    minWidth: 0,
  },
  footer: {
    marginTop: 4,
    gap: 6,
  },
  footerTouch: {
    // the whole footer row is the menu entry: give it a bit of vertical touch height
    paddingVertical: 2,
  },
  inlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  attachment: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginVertical: 4,
  },
})
