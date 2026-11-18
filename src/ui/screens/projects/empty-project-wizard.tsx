/**
 * Empty-project wizard: shown centered in the Project files list when the project root holds no visible
 * entries - [Import files] (existing picker flow) + [Git clone] (clone page fills the empty project).
 */
import React from "react"
import { StyleSheet, View } from "react-native"
import { Button, useTheme } from "react-native-paper"

export function EmptyProjectWizard({ onImport, onClone }: { onImport: () => void; onClone: () => void }) {
  const theme = useTheme()
  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <Button mode="contained" icon="file-import" onPress={onImport} style={styles.btn}>
          Import files
        </Button>
        <Button mode="outlined" icon="source-repository" onPress={onClone} style={styles.btn}>
          Git clone
        </Button>
        <View style={[styles.hint, { borderTopColor: theme.colors.outlineVariant }]}>
          <Button mode="text" compact icon="plus" onPress={onImport}>
            or add files later from the top bar
          </Button>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { marginTop: 48, alignItems: "center", paddingHorizontal: 24 },
  card: { width: "100%", maxWidth: 320, gap: 10 },
  btn: { width: "100%" },
  hint: { marginTop: 6, alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 4 },
})
