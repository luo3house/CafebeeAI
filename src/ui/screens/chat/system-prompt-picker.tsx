/**
 * System Prompt quick switcher dialog (rule 35): AppDialog with a height-capped, internally scrolling list of
 * name-only row buttons - the built-in "Ask" (the old Default: unbound/unknown bindings resolve to it) and "Code"
 * pinned first by the store list, custom entries localeCompare-sorted behind them. The current binding is
 * highlighted with the primaryContainer pill; a tap binds immediately (sticky, affects only the next turn, like
 * the model binding) and dismisses with no second confirmation. The fixed [Manage prompts] action closes the
 * dialog and opens the global System Prompts CRUD page.
 * The list is read from the (non-reactive) store when the dialog opens; CRUD edits are picked up on re-open.
 */
import React, { useEffect, useState } from "react"
import { ScrollView, StyleSheet, Text } from "react-native"
import { useTheme } from "react-native-paper"
import { fs } from "../../../app/app.ui.theme"
import { AppDialog } from "../../components/app-dialog"
import { dialogCompact } from "../../components/dialog-compact"
import { DialogButton } from "../../components/dialog-button"
import { AppPressable } from "../../components/app-pressable"
import { kSystemPromptStore, type SystemPromptEntry } from "../../../core/system-prompts"

export interface SystemPromptPickerProps {
  visible: boolean
  /** effective bound entry id: unbound or unknown already resolved to the built-in Ask id */
  currentId: string
  onDismiss: () => void
  onPick: (id: string) => void
  onManage: () => void
}

export function SystemPromptPicker({ visible, currentId, onDismiss, onPick, onManage }: SystemPromptPickerProps) {
  const theme = useTheme()
  const [entries, setEntries] = useState<SystemPromptEntry[]>([])

  useEffect(() => {
    if (visible) setEntries(kSystemPromptStore().list())
  }, [visible])

  return (
    <AppDialog visible={visible} onDismiss={onDismiss}>
      <AppDialog.Title style={dialogCompact.title}>System Prompt</AppDialog.Title>
      <AppDialog.Content style={dialogCompact.content}>
        <ScrollView style={styles.listCap} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
          {entries.map((entry) => {
            const selected = entry.id === currentId
            return (
              <AppPressable
                key={entry.id}
                accessibilityRole="button"
                onPress={() => onPick(entry.id)}
                pressedStyle={styles.rowPressed}
                style={[styles.row, selected && { backgroundColor: theme.colors.primaryContainer }]}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    styles.rowText,
                    { fontSize: fs(theme, 14), color: selected ? theme.colors.onPrimaryContainer : theme.colors.onSurface },
                  ]}
                >
                  {entry.name}
                </Text>
              </AppPressable>
            )
          })}
        </ScrollView>
      </AppDialog.Content>
      <AppDialog.Actions style={dialogCompact.actions}>
        <DialogButton onPress={onDismiss}>Cancel</DialogButton>
        <DialogButton mode="contained" onPress={onManage}>
          Manage prompts
        </DialogButton>
      </AppDialog.Actions>
    </AppDialog>
  )
}

const styles = StyleSheet.create({
  // height cap (~4 rows visible), the rest scrolls internally
  listCap: { maxHeight: 264 },
  list: { gap: 4 },
  row: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  rowPressed: { opacity: 0.75 },
  rowText: { fontSize: 14 },
})
