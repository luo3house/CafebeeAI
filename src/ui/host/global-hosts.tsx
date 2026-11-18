/**
 * Global hosts: Snackbar (success light toasts) + problem-notice confirm dialog.
 * Mounted under the RootNavigator.
 * (Provider/model selection = the ModelPicker full-screen page; write confirmation moved inline into tool cards, the dialog host has been removed)
 */
import React from "react"
import { Portal, Snackbar, Text } from "react-native-paper"
import { useSnapshot } from "valtio"
import { toastState, dismissToast } from "../../state/toast"
import { noticeState, dismissNotice } from "../../state/notice"
import { AppDialog } from "../components/app-dialog"
import { DialogButton } from "../components/dialog-button"
import { dialogCompact } from "../components/dialog-compact"
import { dialogLiftStyle, useKeyboardLift } from "../use-keyboard-lift"

export function GlobalHosts() {
  const toast = useSnapshot(toastState)
  const notice = useSnapshot(noticeState)
  const lift = useKeyboardLift()
  return (
    <>
      <Portal>
        <Snackbar
          visible={toast.visible}
          onDismiss={dismissToast}
          duration={2200}
        >
          {toast.message}
        </Snackbar>
      </Portal>
      <AppDialog visible={notice.visible} onDismiss={dismissNotice} style={dialogLiftStyle(lift)}>
        {notice.title ? <AppDialog.Title style={dialogCompact.title}>{notice.title}</AppDialog.Title> : null}
        <AppDialog.Content style={notice.title ? dialogCompact.content : [dialogCompact.content, { paddingTop: 18 }]}>
          <Text variant="bodyMedium">{notice.message}</Text>
        </AppDialog.Content>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton mode="contained" onPress={dismissNotice}>
            OK
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>
    </>
  )
}
