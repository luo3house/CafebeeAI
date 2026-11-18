/**
 * Tool detail page: opened by tapping a tool_call card's title row (view-only snapshot; pending-confirmation write cards
 * keep their inline preview instead - that tap belongs to the approval flow; the pending download card instead routes here
 * with an approvalNote, so every download tap - pending, running or terminal - shows details on this single screen).
 * Full markdown H1+H2/paragraph structure shows everything the one-line cards truncate: card indicator, persisted status + call id,
 * every input arg, output result, error.
 * Same full-screen recipe as AnswerFull/ReasoningFull: headerShown:false + own Appbar, selectable text, non-compact typography.
 * Copy is en-US (Rule 14). Long/multiline values go into fenced code blocks; a value containing its own ``` falls back to plain text.
 */
import React from "react"
import { ScrollView, StyleSheet, View } from "react-native"
import { useNavigation } from "@react-navigation/native"
import { Appbar, useTheme } from "react-native-paper"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { MessagePartToolCall } from "../../../core/chats"
import { MarkdownBlock } from "../../components/markdown"
import { NAME_LABEL } from "../../components/tool-card"

export interface ToolDetailParams {
  part: MessagePartToolCall
  /** The indicator text the card shows (e.g. "Done" / "3 lines" / "Pending" / "Cancelled") */
  indicator: string
  /** Extra approval-context paragraph rendered under Indicator (pending download hub card: overwrite warning + "downloaded after approval") */
  approvalNote?: string
}

function valueToMarkdown(value: unknown): string {
  const s = typeof value === "string" ? value : (() => { try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return String(value) } })()
  if (s.length === 0) return "_(empty)_"
  if (!s.includes("\n") && !s.includes("```")) return s
  if (s.includes("```")) return s
  return "```\n" + s + "\n```"
}

export function buildToolDetailMarkdown(part: MessagePartToolCall, indicator: string, approvalNote?: string): string {
  const out: string[] = []
  out.push(`# ${NAME_LABEL[part.name] ?? part.name}`, "")

  out.push("## Indicator", "", `Card indicator: **${indicator}**`, "")
  if (approvalNote) out.push(approvalNote, "")

  out.push("## Tool call", "", `Name: \`${part.name}\``, "", `Status: \`${part.status ?? "running"}\``, "", `Call id: \`${part.id}\``, "")

  const entries = Object.entries(part.args ?? {})
  out.push("## Input", "")
  if (entries.length === 0) out.push("_No arguments._", "")
  for (const [key, value] of entries) {
    out.push(`### ${key}`, "", valueToMarkdown(value), "")
  }

  out.push("## Output", "", part.result ? valueToMarkdown(part.result) : "_No result._", "")
  out.push("## Error", "", part.error ? valueToMarkdown(part.error) : "_None._", "")
  return out.join("\n")
}

export function ToolDetailScreen({ route }: { route: any }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const navigation = useNavigation<any>()
  const params: ToolDetailParams | undefined = route?.params
  const part = params?.part
  if (!part) return null
  const markdown = buildToolDetailMarkdown(part, params?.indicator ?? String(part.status ?? "running"), params?.approvalNote)

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background, paddingBottom: insets.bottom }]}>
      <Appbar.Header mode="small" style={{ elevation: 0 }}>
        <Appbar.BackAction onPress={() => navigation.goBack()} />
        <Appbar.Content title={`${NAME_LABEL[part.name] ?? part.name} details`} />
      </Appbar.Header>
      <ScrollView style={styles.flex} contentContainerStyle={{ padding: 12 }}>
        <MarkdownBlock content={markdown} selectable color={theme.colors.onSurface} />
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
})
