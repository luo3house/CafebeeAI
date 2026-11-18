/**
 * Mini tag button inside cards: matches the small tool_call cards' font size (12 / line-height 16) and lightness,
 * replacing Paper Button (pill radius + min width/height) where approve/entry buttons live inside a card.
 * primary = solid pill on primaryContainer (the only affirmative tone: Approve/Open always follow the theme, never error red);
 * danger = hollow pill with error outline (Reject);
 * neutral = hollow pill with a plain outline stroke (inspection actions, e.g. the download card's Open-URL button -
 * it neither approves nor rejects, so it must not borrow the affirmative fill).
 */
import React from "react"
import { StyleSheet, Text, type StyleProp, type TextStyle, type ViewStyle } from "react-native"
import { useTheme } from "react-native-paper"
import { fs } from "../../app/app.ui.theme"
import { AppPressable } from "./app-pressable"

export type TagButtonTone = "primary" | "danger" | "neutral"

export interface TagButtonProps {
  label: string
  tone?: TagButtonTone
  /** omitted = display only (for debug style checks), does not respond to presses */
  onPress?: () => void
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}

export function TagButton({ label, tone = "primary", onPress, disabled, style }: TagButtonProps) {
  const theme = useTheme()
  let toneStyle: ViewStyle
  let textColor: string
  if (tone === "danger") {
    toneStyle = { backgroundColor: "transparent", borderColor: theme.colors.error }
    textColor = theme.colors.error
  } else if (tone === "neutral") {
    toneStyle = { backgroundColor: "transparent", borderColor: theme.colors.outline }
    textColor = theme.colors.onSurfaceVariant
  } else {
    toneStyle = { backgroundColor: theme.colors.primaryContainer, borderColor: "transparent" }
    textColor = theme.colors.onPrimaryContainer
  }

  return (
    <AppPressable
      disabled={disabled}
      onPress={onPress}
      pressedStyle={styles.pressed}
      style={[styles.base, toneStyle, style]}
    >
      <Text style={[styles.label, { color: textColor, fontSize: fs(theme, 12), lineHeight: fs(theme, 16) } as TextStyle]}>{label}</Text>
    </AppPressable>
  )
}

const styles = StyleSheet.create({
  base: { borderRadius: 5, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  pressed: { opacity: 0.75 },
  label: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
    textAlign: "center",
    paddingTop: 3,
    paddingBottom: 3,
    paddingLeft: 8,
    paddingRight: 8,
  },
})
