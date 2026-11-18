/**
 * Code block: horizontal scrolling + one-tap copy.
 * Colors follow the theme's surface levels (elevation.level2 body / level3 header + onSurface text + onSurfaceVariant secondary), never locked to dark in light/dark/newsprint.
 * compact=true (inside AI answer articles): font size/icons/buttons/padding shrink down to the tool-card level (12 font, 14 icons, 6~8 padding).
 */
import React, { useState } from "react"
import { ScrollView, StyleSheet, Text, View } from "react-native"
import { Button, Icon, useTheme } from "react-native-paper"
import { fs } from "../../app/app.ui.theme"
import Clipboard from "../../vendor/clipboard"
import { showToast } from "../../state/toast"

export function CodeBlock({ code, language, compact, wrap }: { code: string; language?: string; compact?: boolean; wrap?: boolean }) {
  const theme = useTheme()
  const [copied, setCopied] = useState(false)

  const onCopy = async () => {
    await Clipboard.setString(code)
    setCopied(true)
    showToast("Code copied")
    setTimeout(() => setCopied(false), 1600)
  }

  const codeText = compact ? styles.codeCompact : styles.code
  const codeTextStyle = [codeText, { color: theme.colors.onSurface, fontSize: fs(theme, compact ? 12 : 13), lineHeight: compact ? fs(theme, 16) : undefined }]

  const langSize = fs(theme, compact ? 11 : 12)

  return (
    <View
      style={[
        styles.container,
        compact && styles.containerCompact,
        {
          borderRadius: compact ? 8 : 10,
          overflow: "hidden",
          backgroundColor: theme.colors.elevation.level2,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.outlineVariant,
        },
      ]}
    >
      <View style={[styles.header, compact && styles.headerCompact, { backgroundColor: theme.colors.elevation.level3 }]}>
        <View style={styles.langRow}>
          <Icon source="code-tags" size={compact ? 12 : 14} color={theme.colors.onSurfaceVariant} />
          <Text style={[styles.lang, compact && styles.langCompact, { color: theme.colors.onSurfaceVariant, fontSize: langSize }]}>{language || "code"}</Text>
        </View>
        <Button
          compact
          style={[styles.copyBtn, compact && styles.copyBtnCompact]}
          labelStyle={[styles.copyLabel, compact && styles.copyLabelCompact, { fontSize: langSize, lineHeight: compact ? fs(theme, 16) : undefined }]}
          textColor={theme.colors.onSurfaceVariant}
          onPress={onCopy}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </View>
      {wrap ? (
        <Text style={codeTextStyle}>{code}</Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator style={[styles.scroll, compact && styles.scrollCompact]}>
          <Text style={codeTextStyle}>{code}</Text>
        </ScrollView>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 4,
  },
  containerCompact: {
    marginVertical: 3,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  headerCompact: {
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  langRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  lang: {
    fontSize: 12,
    fontFamily: "monospace",
  },
  langCompact: {
    fontSize: 11,
  },
  copyBtn: {
    margin: 0,
  },
  copyBtnCompact: {
    minHeight: 24,
  },
  copyLabel: {
    fontSize: 12,
  },
  copyLabelCompact: {
    fontSize: 11,
    lineHeight: 16,
    paddingVertical: 2,
  },
  scroll: {
    maxHeight: 340,
  },
  scrollCompact: {
    maxHeight: 220,
  },
  code: {
    fontFamily: "monospace",
    fontSize: 13,
    padding: 12,
  },
  codeCompact: {
    fontSize: 12,
    lineHeight: 16,
    padding: 8,
  },
})
