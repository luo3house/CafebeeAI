/**
 * Reasoning block: four display modes (global default + per-message switch).
 * min=Minimize (shows only the reasoning character count, global default); inline=expand all; scroll=scroll area (height-limited, auto-scrolls to bottom); full= tapping the icon opens the standalone full page.
 * Display mode is switched with icon buttons only — never expand/collapse text buttons.
 */
import React, { useEffect, useRef, useState } from "react"
import { ScrollView, StyleSheet, Text, View } from "react-native"
import { useTheme, IconButton, Icon } from "react-native-paper"
import { fs } from "../../app/app.ui.theme"
import { settings, type ReasoningMode } from "../../state/settings"
import { openReasoningViewer } from "../../state/reasoning"
import { useNavigation } from "@react-navigation/native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../app/app.ui.navigator"

const LABEL_FONT_SIZE = 12

export function ReasoningBlock({ text, forcedMode }: { text: string; forcedMode?: ReasoningMode }) {
  const theme = useTheme()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const [localMode, setLocalMode] = useState<ReasoningMode | null>(null)
  const mode: ReasoningMode = localMode ?? forcedMode ?? settings.reasoningMode
  const scrollRef = useRef<ScrollView>(null)

  const openFull = () => {
    openReasoningViewer(text, "Reasoning")
    navigation.navigate("ReasoningFull")
  }

  // When partially shown (scroll, height-limited), streaming increments always scroll to the latest line
  useEffect(() => {
    if (mode === "scroll") scrollRef.current?.scrollToEnd({ animated: false })
  }, [text, mode])

  const modes: { key: ReasoningMode; icon: string; hint: string }[] = [
    { key: "min", icon: "window-minimize", hint: "Minimize" },
    { key: "inline", icon: "page-layout-body", hint: "Expand all" },
    { key: "scroll", icon: "format-list-bulleted", hint: "Scroll" },
    { key: "full", icon: "open-in-new", hint: "Full page" },
  ]

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surfaceVariant }]}>
      <View style={styles.header}>
        <View style={styles.labelRow}>
          <Icon source="brain" size={LABEL_FONT_SIZE} color={theme.colors.onSurfaceVariant} />
          <Text style={[styles.label, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, LABEL_FONT_SIZE) }]} onLongPress={openFull}>Reasoning</Text>
        </View>
        <View style={styles.tools}>
          {modes.map((m) => (
            <IconButton
              key={m.key}
              icon={m.icon}
              size={LABEL_FONT_SIZE}
              accessibilityLabel={m.hint}
              selected={mode === m.key}
              onPress={() => {
                if (m.key === "full") openFull()
                else setLocalMode(m.key)
              }}
              style={{ margin: 0, padding: 0 }}
            />
          ))}
        </View>
      </View>

      {mode === "min" ? (
        <Text style={[styles.preview, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12), lineHeight: fs(theme, 18) }]} numberOfLines={1} onPress={openFull}>
          {text.length} chars
        </Text>
      ) : mode === "inline" ? (
        <Text style={[styles.text, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 13), lineHeight: fs(theme, 20) }]}>{text}</Text>
      ) : mode === "scroll" ? (
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          <Text style={[styles.text, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 13), lineHeight: fs(theme, 20) }]}>{text}</Text>
        </ScrollView>
      ) : (
        <Text style={[styles.preview, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12), lineHeight: fs(theme, 18) }]} numberOfLines={1} onPress={openFull}>
          {text.slice(0, 80)}
        </Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 4,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  label: {
    fontSize: LABEL_FONT_SIZE,
    fontWeight: "600",
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  tools: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  text: {
    fontSize: 13,
    lineHeight: 20,
  },
  preview: {
    fontSize: 12,
    lineHeight: 18,
  },
  scroll: {
    maxHeight: 160,
    marginVertical: 4,
  },
})
