/**
 * Generic confirmation dialog (AppDialog shell, the replacement for Alert / Paper Dialog).
 */
import React from "react"
import { StyleSheet } from "react-native"
import { Text, useTheme } from "react-native-paper"
import { dialogCompact } from "./dialog-compact"
import { DialogButton } from "./dialog-button"
import { AppDialog } from "./app-dialog"

export interface ConfirmDialogProps {
  visible: boolean
  title: string
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  visible,
  title,
  body,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const theme = useTheme()
  return (
    <AppDialog visible={visible} onDismiss={onCancel} style={styles.dialog}>
      <AppDialog.Title style={dialogCompact.title}>{title}</AppDialog.Title>
      {body ? (
        <AppDialog.Content style={dialogCompact.content}>
          <Text variant="bodyMedium">{body}</Text>
        </AppDialog.Content>
      ) : null}
      <AppDialog.Actions style={dialogCompact.actions}>
        <DialogButton onPress={onCancel}>{cancelLabel}</DialogButton>
        <DialogButton
          mode="contained"
          buttonColor={danger ? theme.colors.error : undefined}
          textColor={danger ? theme.colors.onError : undefined}
          onPress={onConfirm}
        >
          {confirmLabel}
        </DialogButton>
      </AppDialog.Actions>
    </AppDialog>
  )
}

const styles = StyleSheet.create({
  dialog: { maxWidth: 320 },
})