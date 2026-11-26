/**
 * Debug page notification harness: posts real system notifications (bypassing the opt-in switch and the
 * background gate) so the channel, icon, sound and tap navigation can be verified manually; also links to the
 * battery optimization page. Acceptance is manual in this repo (no automated tests).
 */
import React from "react"
import { StyleSheet, Text, View } from "react-native"
import { useNavigation } from "@react-navigation/native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import { useTheme } from "react-native-paper"
import { fs, type MD3Theme } from "../../../app/app.ui.theme"
import { showToast } from "../../../state/toast"
import { postDebugNotification } from "../../../state/notifications"
import { TagButton } from "../../components/tag-button"
import type { RootStackParamList } from "../../../app/app.ui.navigator"

export function NotificationDemoSection() {
  const theme = useTheme<MD3Theme>()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()

  const send = async (kind: "done" | "attention") => {
    const ok = await postDebugNotification(kind)
    showToast(ok ? "Notification posted" : "Notifications are disabled")
  }

  return (
    <View style={styles.wrap}>
      <Text style={[styles.title, { color: theme.colors.onSurface, fontSize: fs(theme, 14) }]}>Notifications</Text>
      <View style={styles.row}>
        <TagButton label="Send completion test notification" onPress={() => void send("done")} />
        <TagButton label="Send needs-attention test notification" onPress={() => void send("attention")} />
        <TagButton label="Open battery optimization page" tone="neutral" onPress={() => navigation.navigate("BatteryOptimization")} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginBottom: 12 },
  title: { fontWeight: "700" },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
})