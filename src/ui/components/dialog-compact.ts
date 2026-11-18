/**
 * Paper 5.15's Dialog has no contentPadding prop; the default margin/padding at every level is 24 (and Dialog force-adds marginTop 24 to the first child).
 * Compact spacing is done uniformly via subcomponent `style` overrides: 16 horizontal, roughly half the default vertical.
 */
import { StyleSheet } from "react-native"

export const dialogCompact = StyleSheet.create({
  title: { marginHorizontal: 16, marginTop: 18, marginBottom: 6 },
  content: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 10 },
  scrollArea: { marginHorizontal: 12, paddingHorizontal: 16, marginBottom: 0 },
  actions: { paddingHorizontal: 12, paddingTop: 0, paddingBottom: 12, minHeight: 40, marginBottom: 0 },
})
