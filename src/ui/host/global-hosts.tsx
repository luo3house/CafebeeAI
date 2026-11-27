/**
 * Global hosts: Snackbar (success light toasts) + problem-notice confirm dialog + hidden EvalHost (run_javascript WebViews).
 * Mounted under the RootNavigator.
 * (Provider/model selection = the ModelPicker full-screen page; write confirmation moved inline into tool cards, the dialog host has been removed)
 */
import React from "react"
import { useWindowDimensions } from "react-native"
import { Portal, Snackbar, Text } from "react-native-paper"
import { useSnapshot } from "valtio"
import { toastState, dismissToast } from "../../state/toast"
import { noticeState, dismissNotice } from "../../state/notice"
import { AppDialog } from "../components/app-dialog"
import { DialogButton } from "../components/dialog-button"
import { dialogCompact } from "../components/dialog-compact"
import { dialogLiftStyle, useKeyboardLift } from "../use-keyboard-lift"
import { EvalHost } from "./eval-host"

export function GlobalHosts() {
  const toast = useSnapshot(toastState)
  const notice = useSnapshot(noticeState)
  const lift = useKeyboardLift()
  const { height: windowHeight, width: windowWidth } = useWindowDimensions()
  return (
    <>
      <Portal>
        <Snackbar
          visible={toast.visible}
          onDismiss={dismissToast}
          duration={2200}
          // lift the toast 10% of screen height above the bottom; opacity rides the wrapper so
          // Paper's own fade-in/out animation (on the inner Surface) still multiplies through it
          wrapperStyle={{ bottom: windowHeight * 0.1, opacity: 0.85 }}
          // horizontal inset = 8% of screen width (overrides the default margin: 8 side components)
          style={{ marginHorizontal: windowWidth * 0.08 }}
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
      <EvalHost />
    </>
  )
}
