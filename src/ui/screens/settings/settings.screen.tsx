/**
 * Settings page: Provider management / default reasoning display mode / tool approval / theme / projects / about.
 */
import React, { useState } from "react"
import { ScrollView, StyleSheet, View } from "react-native"
import { List, Divider, RadioButton, Switch } from "react-native-paper"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useSnapshot } from "valtio"
import { settings, setThemeMode, setReasoningMode, setAutoApproveWrites, setFontScale, FONT_SCALE_PRESETS, type ThemeMode } from "../../../state/settings"
import { APP_BUILD_LABEL } from "../../../app/app.constants"
import { ConfirmDialog } from "../../components/confirm-dialog"
import Config from "react-native-config"

export function SettingsScreen({ navigation }: { navigation: any }) {
  const snap = useSnapshot(settings)
  const insets = useSafeAreaInsets()
  const [confirmAuto, setConfirmAuto] = useState(false)

  const toggleAutoApprove = (next: boolean) => {
    if (next) setConfirmAuto(true)
    else setAutoApproveWrites(false)
  }

  const fontPresets = [
    { scale: FONT_SCALE_PRESETS[0], label: "Small" },
    { scale: FONT_SCALE_PRESETS[1], label: "Default" },
    { scale: FONT_SCALE_PRESETS[2], label: "Large" },
    { scale: FONT_SCALE_PRESETS[3], label: "Extra large" },
  ]

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: insets.bottom }}>
      <List.Section>
        <List.Item
          style={styles.listItem}
          title="Providers"
          description="Configure OpenAI-compatible endpoints, keys, and custom headers"
          left={(p) => <List.Icon {...p} icon="server-network" />}
          onPress={() => navigation.navigate("Providers")}
        />
        <Divider />
        <List.Item
          style={styles.listItem}
          title="Projects"
          description="Create, rename, and delete projects"
          left={(p) => <List.Icon {...p} icon="folder-cog-outline" />}
          onPress={() => navigation.navigate("ProjectManage")}
        />
        <Divider />
        <List.Item
          style={styles.listItem}
          title="System Prompts"
          description="Reusable default-first prompt presets for the chat quick switcher"
          left={(p) => <List.Icon {...p} icon="note-text-outline" />}
          onPress={() => navigation.navigate("SystemPrompts")}
        />
        <Divider />
        <List.Item
          style={styles.listItem}
          title="Skills"
          description="Text snippets expanded by /name in the chat input"
          left={(p) => <List.Icon {...p} icon="lightning-bolt-outline" />}
          onPress={() => navigation.navigate("Skills")}
        />
        <Divider />
        <List.Item
          style={styles.listItem}
          title="Global Git Config"
          description="Credentials, commit author, and trusted SSH hosts"
          left={(p) => <List.Icon {...p} icon="git" />}
          onPress={() => navigation.navigate("GitConfig")}
        />
        {/* Gate key is APP_DEBUG - never DEBUG: AGP owns BuildConfig.DEBUG implicitly, and
            dotenv.gradle's String declaration collides with it (generated BuildConfig breaks
            javac in both flavors). See AGENTS.md gotcha. */}
        {Config.APP_DEBUG === "1" && (
          <>
            <Divider />
            <List.Item
              style={styles.listItem}
              title="Debug"
              description="Developer debugging tools"
              left={(p) => <List.Icon {...p} icon="bug-outline" />}
              onPress={() => navigation.navigate("Debug")}
            />
          </>
        )}
        <Divider />
        <List.Item
          style={styles.listItem}
          title="About"
          description={APP_BUILD_LABEL}
          left={(p) => <List.Icon {...p} icon="information-outline" />}
          onPress={() => navigation.navigate("About")}
        />
      </List.Section>

      <List.Section>
        <List.Subheader>Theme</List.Subheader>
        <RadioButton.Group onValueChange={(v) => setThemeMode(v as ThemeMode)} value={snap.themeMode}>
          <RadioButton.Item style={styles.radioRow} label="System" value="system" />
          <RadioButton.Item style={styles.radioRow} label="Newsprint" value="newsprint" />
          <RadioButton.Item style={styles.radioRow} label="Light" value="light" />
          <RadioButton.Item style={styles.radioRow} label="Dark" value="dark" />
        </RadioButton.Group>
      </List.Section>

      <List.Section>
        <List.Subheader>Default reasoning display mode</List.Subheader>
        <RadioButton.Group onValueChange={(v) => setReasoningMode(v as "min" | "inline" | "scroll" | "full")} value={snap.reasoningMode}>
          <RadioButton.Item style={styles.radioRow} label="Minimize (default, shows only the character count)" value="min" />
          <RadioButton.Item style={styles.radioRow} label="Expand all (shows the full reasoning inline)" value="inline" />
          <RadioButton.Item style={styles.radioRow} label="Scroll (height-limited view, auto-scrolls to the latest)" value="scroll" />
          <RadioButton.Item style={styles.radioRow} label="Full page (tap to open a full-screen page)" value="full" />
        </RadioButton.Group>
      </List.Section>

      <List.Section>
        <List.Subheader>Font size</List.Subheader>
        <RadioButton.Group onValueChange={(v) => setFontScale(Number(v))} value={String(snap.fontScale)}>
          {fontPresets.map((p) => (
            <RadioButton.Item key={p.scale} style={styles.radioRow} label={`${p.label} (${Math.round(p.scale * 100)}%)`} value={String(p.scale)} />
          ))}
        </RadioButton.Group>
      </List.Section>

      <List.Section>
        <List.Subheader>Tool approval</List.Subheader>
        <List.Item
          style={styles.listItem}
          title="Auto-approve writes"
          description="When on, AI file writes/edits/downloads run without per-step confirmation"
          left={(p) => <List.Icon {...p} icon="shield-check-outline" />}
          onPress={() => toggleAutoApprove(!snap.autoApproveWrites)}
          right={() => (
            <View style={styles.switchWrap}>
              <Switch value={snap.autoApproveWrites} onValueChange={toggleAutoApprove} />
            </View>
          )}
        />
        <ConfirmDialog
          visible={confirmAuto}
          title="Enable auto-approve?"
          body="AI file writes, edits, and URL downloads will run automatically without asking each time. Judge risky operations yourself; restarting the app resets this to off."
          confirmLabel="Enable"
          danger
          onConfirm={() => {
            setAutoApproveWrites(true)
            setConfirmAuto(false)
          }}
          onCancel={() => setConfirmAuto(false)}
        />
      </List.Section>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listItem: { minHeight: 44, paddingVertical: 2 },
  radioRow: { paddingVertical: 3 },
  switchWrap: { justifyContent: "center", marginRight: 4 },
})
