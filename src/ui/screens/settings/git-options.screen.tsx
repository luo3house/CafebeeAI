/**
 * Global Git options page (Settings > Git Options): commit author identity, TLS verification,
 * SSH host-key policy. Persisted to git-options.json (non-secret).
 */
import React, { useState } from "react"
import { ScrollView, StyleSheet, View } from "react-native"
import { Button, Switch, Text, TextInput, useTheme } from "react-native-paper"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { fs } from "../../../app/app.ui.theme"
import { RadioRow } from "../../components/option-row"
import { useKeyboardLift } from "../../use-keyboard-lift"
import { showNotice } from "../../../state/notice"
import { showToast } from "../../../state/toast"
import { kGitOptions, type GitHostKeyPolicy } from "../../../core/git-options"

export function GitOptionsScreen() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const keyboardLift = useKeyboardLift()
  const [authorName, setAuthorName] = useState(kGitOptions().get().authorName)
  const [authorEmail, setAuthorEmail] = useState(kGitOptions().get().authorEmail)
  const [sslVerify, setSslVerify] = useState(kGitOptions().get().sslVerify)
  const [hostKeyPolicy, setHostKeyPolicy] = useState<GitHostKeyPolicy>(kGitOptions().get().hostKeyPolicy)

  const onSave = async () => {
    const name = authorName.trim()
    const email = authorEmail.trim()
    if (!name || !email) {
      showNotice("Author name and email cannot be empty.", { title: "Invalid author" })
      return
    }
    await kGitOptions().save({ authorName: name, authorEmail: email, sslVerify, hostKeyPolicy })
    showToast("Git options saved")
  }

  return (
    <View style={{ flex: 1, marginBottom: keyboardLift }} pointerEvents="box-none">
      <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.content, { paddingBottom: 24 + insets.bottom }]} keyboardShouldPersistTaps="handled">
        <Text style={[styles.section, { color: theme.colors.onSurface, fontSize: fs(theme, 14) }]}>Commit author</Text>
        <TextInput
          mode="outlined"
          dense
          label="Name"
          value={authorName}
          onChangeText={setAuthorName}
          autoCapitalize="words"
        />
        <TextInput
          mode="outlined"
          dense
          label="Email"
          value={authorEmail}
          onChangeText={setAuthorEmail}
          autoCapitalize="none"
          style={styles.field}
        />
        <Text style={[styles.section, { color: theme.colors.onSurface, fontSize: fs(theme, 14) }]}>Network security</Text>
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: theme.colors.onSurface, fontSize: fs(theme, 14) }}>Verify TLS certificates</Text>
            <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }}>
              Turn off only for self-hosted servers with self-signed certificates.
            </Text>
          </View>
          <Switch value={sslVerify} onValueChange={setSslVerify} />
        </View>
        <View style={styles.switchRow}>
          <Text style={{ flex: 1, color: theme.colors.onSurface, fontSize: fs(theme, 14) }}>SSH host key policy</Text>
        </View>
        <RadioRow
          value="tofu"
          checked={hostKeyPolicy === "tofu"}
          title="Trust on first use"
          titleStyle={{ fontSize: fs(theme, 14) }}
          description="Unknown hosts are accepted on first connection."
          onPress={() => setHostKeyPolicy("tofu")}
        />
        <RadioRow
          value="skip"
          checked={hostKeyPolicy === "skip"}
          title="Skip host verification"
          titleStyle={{ fontSize: fs(theme, 14) }}
          description="Host keys are never checked. Only for trusted networks."
          onPress={() => setHostKeyPolicy("skip")}
        />
        <Button mode="contained" icon="check" onPress={() => void onSave()} style={styles.saveBtn}>
          Save
        </Button>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  section: { letterSpacing: 0.2, marginTop: 8 },
  field: {},
  switchRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  saveBtn: { marginTop: 10 },
})
