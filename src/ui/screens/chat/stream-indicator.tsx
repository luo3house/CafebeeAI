/**
 * Floating request-status indicator above the input bar: shown only while a request is active (streaming), full width, no rounded corners.
 * Background is a react-native-linear-gradient native vertical gradient (top = transparent → bottom = solid page background color):
 * both ends use the same RGB varying only alpha (transparent is transparent black, a direct gradient would look muddy); the bottom joins the input area seamlessly, the top fades into the message list.
 * Depends on react-native-linear-gradient@3.x (Fabric new-architecture codegen component, matching newArchEnabled=true).
 * The WIP icon uses an infinite spin animation (Animated.loop + native driver); text uses a small font size with an explicit theme color.
 */
import React, { useEffect, useRef } from "react"
import { Animated, Easing, StyleSheet, Text, View } from "react-native"
import LinearGradient from "react-native-linear-gradient"
import { Icon, useTheme } from "react-native-paper"
import { fs, type MD3Theme } from "../../../app/app.ui.theme"

function hexToRgb(color: string): [number, number, number] | null {
  const hex = color.trim().toLowerCase()
  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex)
  if (m6) return [parseInt(m6[1], 16), parseInt(m6[2], 16), parseInt(m6[3], 16)]
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex)
  if (m3) return [parseInt(m3[1], 16) * 17, parseInt(m3[2], 16) * 17, parseInt(m3[3], 16) * 17]
  return null
}

function withAlpha(color: string, alpha: number): string {
  const rgb = hexToRgb(color)
  if (!rgb) return color
  const a = Math.max(0, Math.min(1, alpha))
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a.toFixed(3)})`
}

export function StreamIndicator({ streaming, humanWait }: { streaming: boolean; humanWait: boolean }) {
  const theme = useTheme<MD3Theme>()
  const spin = useRef(new Animated.Value(0)).current

  const colors = React.useMemo(() => {
    const bg = theme.colors.background
    return [withAlpha(bg, 0), withAlpha(bg, 1)]
  }, [theme.colors.background])

  useEffect(() => {
    if (!streaming) {
      spin.setValue(0)
      return
    }
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1100,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    )
    loop.start()
    return () => loop.stop()
  }, [streaming, spin])

  // Waiting on a human (pending card / pending form) is waiting on people, not the network: hide the indicator, the tool card is the status
  if (!streaming || humanWait) return null

  return (
    <View style={styles.bar}>
      <LinearGradient pointerEvents="none" colors={colors} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={StyleSheet.absoluteFill} />
      <Animated.View style={{ transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }}>
        <Icon source="autorenew" size={12} color={theme.colors.primary} />
      </Animated.View>
      <Text style={[styles.text, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 11), lineHeight: fs(theme, 15) }]}>Request in progress…</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  text: {
    fontSize: 11,
    lineHeight: 15,
  },
})
