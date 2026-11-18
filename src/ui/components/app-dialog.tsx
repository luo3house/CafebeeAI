/**
 * The app's own Dialog shell (replacement for Paper Dialog / Paper Modal).
 *
 * Why not Paper's Dialog:
 * - Paper 5.15's Dialog is built on its own Modal: Surface force-appends `elevation` on Android
 *   (and Dialog carries the legacy-architecture shadow-clipping workaround `elevation: 24 + marginVertical: 44`),
 *   while open/close animates `opacity` with `useNativeDriver: true`. Under the new architecture
 *   (Fabric, RN 0.85) "elevation view + native opacity animation" is promoted to a hardware layer,
 *   the background stops being drawn (only the scrim/mask overlay is visible) and the elevation
 *   shadow lingers as a dirty block — the "missing background / visible shadow" bug.
 * - Dialog's `Portal` relies on callers wrapping it themselves; when the wrap is missed it lays out
 *   in place inside the enclosing screen tree, with wrong position/layering.
 *
 * What this shell does:
 * - Always wraps `Portal` internally (full-screen layer, callers need not wrap);
 * - the card is a plain View with an explicit solid `elevation.level3`, no `elevation`/shadow set at all;
 * - enter/exit fade runs on the JS driver (no hardware-layer promotion), backdrop color `theme.colors.backdrop`;
 * - Title/Content/Actions/ScrollArea/Icon reuse Paper's leaf subcomponents (themed colors included), so the
 *   caller API matches Dialog.
 */
import React, { useEffect, useRef, useState } from "react"
import { Animated, BackHandler, Easing, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native"
import { Dialog, Portal, useTheme } from "react-native-paper"
import { useSafeAreaInsets } from "react-native-safe-area-context"

export interface AppDialogProps {
  visible: boolean
  onDismiss: () => void
  /** Whether tapping the backdrop / pressing back can close it (default true, like Paper Dialog.dismissable) */
  dismissable?: boolean
  style?: StyleProp<ViewStyle>
  children: React.ReactNode
}

const DURATION = 220

function AppDialogBase({ visible, onDismiss, dismissable = true, style, children }: AppDialogProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const fade = useRef(new Animated.Value(visible ? 1 : 0)).current
  const [mounted, setMounted] = useState(visible)

  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useEffect(() => {
    if (visible) {
      setMounted(true)
      Animated.timing(fade, {
        toValue: 1,
        duration: DURATION,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start()
    } else if (mounted) {
      Animated.timing(fade, {
        toValue: 0,
        duration: DURATION,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: false,
      }).start(({ finished }) => {
        if (finished) setMounted(false)
      })
    }
  }, [visible, mounted, fade])

  useEffect(() => {
    if (!mounted || !visible) return undefined
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (dismissable) dismissRef.current()
      return true
    })
    return () => sub.remove()
  }, [mounted, visible, dismissable])

  if (!mounted) return null

  return (
    <Portal>
      <View
        pointerEvents={visible ? "auto" : "none"}
        accessibilityViewIsModal
        style={StyleSheet.absoluteFill}
      >
        <Animated.View
          style={[styles.backdrop, { backgroundColor: theme.colors.backdrop, opacity: fade }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close dialog"
          onPress={dismissable ? () => dismissRef.current() : undefined}
          style={StyleSheet.absoluteFill}
        />
        <View
          pointerEvents="box-none"
          style={[
            styles.wrapper,
            {
              paddingTop: insets.top,
              paddingBottom: insets.bottom,
              // Horizontal whitespace is centralized on the wrapper (not card margins), paired with the
              // card's width:100%: only then does the caller's maxWidth (e.g. 340 in dialogLiftStyle) both
              // cap the width and stay centered, without being squeezed by shrink-wrap
              paddingHorizontal: Math.max(insets.left, insets.right, 26),
            },
          ]}
        >
          <Animated.View
            pointerEvents="auto"
            style={[styles.card, { backgroundColor: theme.colors.elevation.level3, opacity: fade }, style]}
          >
            {children}
          </Animated.View>
        </View>
      </View>
    </Portal>
  )
}

export const AppDialog = Object.assign(AppDialogBase, {
  Title: Dialog.Title,
  Content: Dialog.Content,
  Actions: Dialog.Actions,
  ScrollArea: Dialog.ScrollArea,
  Icon: Dialog.Icon,
})

const styles = StyleSheet.create({
  backdrop: StyleSheet.absoluteFill,
  wrapper: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    width: "100%",
    borderRadius: 7,
    overflow: "hidden",
    maxWidth: "100%",
  },
})
