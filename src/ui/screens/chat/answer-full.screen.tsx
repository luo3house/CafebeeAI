/**
 * Full answer page: shows one assistant reply's markdown on its own fullscreen (carries its own Appbar; navigation config uses headerShown:false).
 * Text selection is open on this page (long-press selection is disabled inside chat-page bubbles); body is non-compact (normal article font size / block elements).
 * Bottom: copy the full text.
 */
import React from "react"
import { ScrollView, StyleSheet, View, Clipboard } from "react-native"
import { Appbar, Button, useTheme } from "react-native-paper"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useSnapshot } from "valtio"
import { answerViewer } from "../../../state/answer"
import { showToast } from "../../../state/toast"
import { MarkdownBlock } from "../../components/markdown"

export function AnswerFullScreen({ navigation }: { navigation: any }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const snap = useSnapshot(answerViewer)

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background, paddingBottom: insets.bottom }]}>
      <Appbar.Header mode="small" style={{ elevation: 0 }}>
        <Appbar.BackAction onPress={() => navigation.goBack()} />
        <Appbar.Content title={snap.title} />
      </Appbar.Header>
      <ScrollView style={styles.flex} contentContainerStyle={{ padding: 12 }}>
        <MarkdownBlock content={snap.markdown} selectable color={theme.colors.onSurface} />
      </ScrollView>
      <View style={styles.actions}>
        <Button
          compact
          mode="contained"
          style={styles.actionBtn}
          icon="content-copy"
          onPress={() => {
            Clipboard.setString(snap.markdown)
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
  actions: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  actionBtn: { flex: 1 },
})
