/**
 * Reasoning full page: a standalone fullscreen page showing all reasoning of one message (carries its own Appbar, navigation configured with headerShown:false).
 * Bottom: export as markdown + copy the raw reasoning text.
 */
import React from "react"
import { ScrollView, StyleSheet, Text, View, Clipboard } from "react-native"
import { Appbar, Button, useTheme } from "react-native-paper"
import { fs } from "../../../app/app.ui.theme"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useSnapshot } from "valtio"
import { reasoningViewer } from "../../../state/reasoning"
import { showToast } from "../../../state/toast"
import { showNotice } from "../../../state/notice"
import { exportReasoningMarkdown } from "../../../core/import-export"

export function ReasoningFullScreen({ navigation }: { navigation: any }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const snap = useSnapshot(reasoningViewer)

  const doExportMarkdown = async () => {
    try {
      await exportReasoningMarkdown(snap.text, snap.title)
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      if (/cancel/i.test(msg)) return
      showNotice(msg, { title: "Export failed" })
    }
  }

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background, paddingBottom: insets.bottom }]}>
      <Appbar.Header mode="small" style={{ elevation: 0 }}>
        <Appbar.BackAction onPress={() => navigation.goBack()} />
        <Appbar.Content title={snap.title} />
      </Appbar.Header>
      <ScrollView style={styles.flex} contentContainerStyle={{ padding: 12 }}>
        <Text style={[styles.text, { color: theme.colors.onSurface, fontSize: fs(theme, 14), lineHeight: fs(theme, 22) }]} selectable>
          {snap.text}
        </Text>
      </ScrollView>
      <View style={styles.actions}>
        <Button compact mode="outlined" style={styles.actionBtn} icon="file-export-outline" onPress={doExportMarkdown}>
          Export as Markdown
        </Button>
        <Button
          compact
          mode="contained"
          style={styles.actionBtn}
          icon="content-copy"
          onPress={() => {
            Clipboard.setString(snap.text)
            showToast("Copied")
          }}
        >
          Copy
        </Button>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  text: { fontSize: 14, lineHeight: 22 },
  actions: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 6,
  },
  actionBtn: { flex: 1 },
})
