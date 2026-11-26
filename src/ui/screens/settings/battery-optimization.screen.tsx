/**
 * Battery optimization page (Settings entry only — no proactive prompts, user-requested self-discovery).
 * Explains why Android may pause background replies, shows the current exemption state, and offers a
 * state-dependent action:
 *   - optimization ON  → "Disable battery optimization" = ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
 *     (falling back to the system battery-optimization list when there is no handler);
 *   - optimization OFF → "Enable battery optimization": Android has NO API for a third-party app to revoke
 *     its own exemption, so this opens the system battery-optimization list where the user can turn it back on
 *     (the page states that limitation explicitly).
 * Status re-reads on focus and on AppState resume (going to the system dialog/settings backgrounds the
 * app instead of re-focusing this screen, so a plain focus re-read would show stale state on return).
 */
import React, { useCallback, useEffect, useState } from "react"
import { AppState, ScrollView, StyleSheet, Text, View } from "react-native"
import { Button, Divider, useTheme } from "react-native-paper"
import { useFocusEffect, useNavigation } from "@react-navigation/native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { fs, type MD3Theme } from "../../../app/app.ui.theme"
import { showNotice } from "../../../state/notice"
import {
  isBatteryOptimizationIgnored,
  openBatterySettings,
  requestBatteryOptimizationExemption,
} from "../../../state/notifications"

export function BatteryOptimizationScreen() {
  const theme = useTheme<MD3Theme>()
  const insets = useSafeAreaInsets()
  const navigation = useNavigation()
  /** null = still checking; true = exempt (unrestricted background, optimization Off); false = optimization On */
  const [ignored, setIgnored] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  const refreshStatus = useCallback(() => {
    void isBatteryOptimizationIgnored().then((v) => setIgnored(v))
  }, [])

  useFocusEffect(
    useCallback(() => {
      refreshStatus()
    }, [refreshStatus])
  )

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && navigation.isFocused()) refreshStatus()
    })
    return () => sub.remove()
  }, [navigation, refreshStatus])

  const openSettingsOrNotice = useCallback(async () => {
    const opened = await openBatterySettings()
    if (!opened) showNotice("Cannot open battery settings on this device.", { title: "Settings unavailable" })
  }, [])

  const onDisable = useCallback(async () => {
    setBusy(true)
    try {
      const launched = await requestBatteryOptimizationExemption()
      if (launched) return
      await openSettingsOrNotice()
    } finally {
      setBusy(false)
    }
  }, [openSettingsOrNotice])

  const onEnable = useCallback(async () => {
    setBusy(true)
    try {
      await openSettingsOrNotice()
    } finally {
      setBusy(false)
    }
  }, [openSettingsOrNotice])

  const statusText = ignored === null ? "Checking…" : ignored ? "Battery optimization: Off" : "Battery optimization: On"

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingBottom: 16 + insets.bottom }]}>
      <Text style={[styles.status, { color: theme.colors.onSurface, fontSize: fs(theme, 16) }]}>{statusText}</Text>

      <Divider />

      <Text style={[styles.body, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 13) }]}>
        When battery optimization is on, Android may pause CafebeeAI while a reply is still generating in the
        background. Turning it off lets background replies finish and notify you.
      </Text>

      {ignored === true ? (
        <Text style={[styles.body, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }]}>
          Android does not allow apps to change this setting directly. Turn it back on in system settings.
        </Text>
      ) : null}

      <View style={styles.actionRow}>
        <Button
          compact
          mode={ignored === true ? "outlined" : "contained"}
          disabled={busy || ignored === null}
          loading={busy}
          onPress={() => void (ignored === true ? onEnable() : onDisable())}
          style={styles.actionBtn}
        >
          {ignored === true ? "Enable battery optimization" : "Disable battery optimization"}
        </Button>
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 12 },
  status: { fontWeight: "700" },
  body: { lineHeight: 19 },
  actionRow: { flexDirection: "row" },
  actionBtn: { borderRadius: 20 },
})