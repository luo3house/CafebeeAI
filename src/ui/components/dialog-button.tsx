/**
 * Dialog action button (centralized style, replaces raw `<Button compact>` inside AppDialog/ConfirmDialog actions):
 * vertical density unchanged (compact kept - the complaint was only "text short + vertical pad" mis-balance, but
 * the pill already sits well vertically), horizontal padding widened, and the MD3 full-round pill softened 16%
 * (radius 20 -> 17) so dialog buttons read as actions rather than chips.
 */
import React from "react"
import { StyleSheet } from "react-native"
import { Button, type ButtonProps } from "react-native-paper"

const styles = StyleSheet.create({
  button: { borderRadius: 17 },
  content: { paddingHorizontal: 20 },
})

export function DialogButton({ style, contentStyle, ...rest }: ButtonProps) {
  return <Button compact style={[styles.button, style]} contentStyle={[styles.content, contentStyle]} {...rest} />
}
