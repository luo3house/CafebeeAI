/**
 * The "+" panel below the input (WeChat-style grid): each item = rounded-square icon + label underneath, the whole cell (icon + text) is the tap area.
 * Current items: Files → project files page; Models → Provider/model picker page.
 * Height reserves a fixed 2-row grid (empty slots act as placeholders when the menu has fewer than 2 rows), expanding with a 50ms linear height animation.
 */
import React, { useEffect, useRef, useState } from "react"
import { Animated, Easing, StyleSheet, Text, View } from "react-native"
import { Icon, useTheme } from "react-native-paper"
import { fs } from "../../../app/app.ui.theme"
import { AppPressable } from "../../components/app-pressable"

export interface InputMoreItem {
  key: string
  icon: string
  label: string
  onPress: () => void
}

/** Single grid row height: icon 56 + label gap 6 + label ~16 + row bottom margin 12 */
const TILE_ROW_HEIGHT = 90
const MIN_TILE_ROWS = 2

export function InputMorePanel({ items }: { items: InputMoreItem[] }) {
  const theme = useTheme()
  const heightAnim = useRef(new Animated.Value(0)).current
  const [contentHeight, setContentHeight] = useState(0)

  useEffect(() => {
    if (contentHeight <= 0) return
    Animated.timing(heightAnim, {
      toValue: contentHeight,
      duration: 50,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start()
  }, [contentHeight, heightAnim])

  return (
    <Animated.View style={{ height: heightAnim, overflow: "hidden" }}>
      <View style={styles.panel} onLayout={(e) => setContentHeight(Math.ceil(e.nativeEvent.layout.height))}>
        <View style={styles.grid}>
          {items.map((item) => (
            <View key={item.key} style={styles.tile}>
              <AppPressable style={styles.tileCell} pressedStyle={styles.tileCellPressed} onPress={item.onPress}>
                <View style={styles.tileCellContent}>
                  <View style={[styles.tileIcon, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }]}>
                    <Icon source={item.icon} size={26} color={theme.colors.onSurfaceVariant} />
                  </View>
                  <Text style={[styles.tileLabel, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }]} numberOfLines={1}>
                    {item.label}
                  </Text>
                </View>
              </AppPressable>
            </View>
          ))}
        </View>
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  panel: { paddingHorizontal: 16, paddingTop: 16 },
  grid: { flexDirection: "row", flexWrap: "wrap", minHeight: TILE_ROW_HEIGHT * MIN_TILE_ROWS },
  tile: { width: "25%", marginBottom: 12 },
  tileCell: { width: "100%" },
  tileCellContent: { alignItems: "center" },
  tileCellPressed: { opacity: 0.7 },
  tileIcon: {
    width: 56,
    height: 56,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  tileLabel: { marginTop: 6, fontSize: 12 },
})
