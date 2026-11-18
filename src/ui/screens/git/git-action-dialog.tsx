/**
 * Git entry dialog (the "+" panel Git tile): vertical actions [Upload] [Sync] [Settings].
 * While the project has no remote configured, only [Settings] is offered (setup/clone live behind it).
 */
import React, { useEffect, useState } from "react"
import { StyleSheet } from "react-native"
import { AppDialog } from "../../components/app-dialog"
import { dialogCompact } from "../../components/dialog-compact"
import { DialogButton } from "../../components/dialog-button"
import { isGitConfigured } from "../../../core/git"

export interface GitActionDialogProps {
  visible: boolean
  projectId: string
  onDismiss: () => void
  onUpload: () => void
  onSync: () => void
  onSettings: () => void
}

export function GitActionDialog({ visible, projectId, onDismiss, onUpload, onSync, onSettings }: GitActionDialogProps) {
  const [configured, setConfigured] = useState(true)

  useEffect(() => {
    if (!visible) return
    let alive = true
    void isGitConfigured(projectId).then((v) => {
      if (alive) setConfigured(v)
    })
    return () => {
      alive = false
    }
  }, [visible, projectId])

  return (
    <AppDialog visible={visible} onDismiss={onDismiss} style={styles.dialog}>
      <AppDialog.Title style={dialogCompact.title}>Git</AppDialog.Title>
      <AppDialog.Actions style={styles.verticalActions}>
        {configured ? (
          <>
            <DialogButton style={styles.wideBtn} mode="contained" onPress={onUpload}>
              Upload
            </DialogButton>
            <DialogButton style={styles.wideBtn} onPress={onSync}>
              Sync
            </DialogButton>
          </>
        ) : null}
        <DialogButton style={styles.wideBtn} onPress={onSettings}>
          Settings
        </DialogButton>
      </AppDialog.Actions>
    </AppDialog>
  )
}

const styles = StyleSheet.create({
  dialog: { maxWidth: 340 },
  verticalActions: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  wideBtn: { width: "100%" },
})
