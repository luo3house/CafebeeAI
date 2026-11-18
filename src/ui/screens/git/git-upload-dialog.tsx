/**
 * Upload dialog: commit message + target branch (branch prefilled from the remembered project preference),
 * in-dialog progress while the op runs (cancellable), push rejection routes to a
 * [Force upload]/[Go sync] confirm dialog. SDK does no UI (rule: explicit destructive params, UI confirms).
 */
import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, StyleSheet, View } from "react-native"
import { Text, TextInput, useTheme } from "react-native-paper"
import { useSnapshot } from "valtio"
import { AppDialog } from "../../components/app-dialog"
import { dialogCompact } from "../../components/dialog-compact"
import { DialogButton } from "../../components/dialog-button"
import { ConfirmDialog } from "../../components/confirm-dialog"
import { fs } from "../../../app/app.ui.theme"
import { useModalInputFocus } from "../../use-modal-input-focus"
import { dialogLiftStyle, useKeyboardLift } from "../../use-keyboard-lift"
import { showNotice } from "../../../state/notice"
import { showToast } from "../../../state/toast"
import { gitState } from "../../../state/git"
import { getSetup, runUpload, cancelGit } from "../../../core/git"
import { GitOpError } from "react-native-pocket-git"

export interface GitUploadDialogProps {
  visible: boolean
  projectId: string
  onDismiss: () => void
  onGoSync: () => void
}

export function GitUploadDialog({ visible, projectId, onDismiss, onGoSync }: GitUploadDialogProps) {
  const theme = useTheme()
  const lift = useKeyboardLift()
  const inputRef = useModalInputFocus(visible)
  const snap = useSnapshot(gitState)
  const rt = snap.byProject[projectId]
  const busy = !!rt?.busy
  const [message, setMessage] = useState("")
  const [branch, setBranch] = useState("main")
  const [conflict, setConflict] = useState(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    let alive = true
    void getSetup(projectId).then((setup) => {
      if (alive && setup.branch) setBranch(setup.branch)
    })
    return () => {
      alive = false
    }
  }, [visible, projectId])

  const doUpload = useCallback(
    async (force: boolean) => {
      if (!message.trim()) {
        showNotice("Enter a commit message.", { title: "Invalid message" })
        return
      }
      if (!branch.trim()) {
        showNotice("Enter a target branch.", { title: "Invalid branch" })
        return
      }
      try {
        const result = await runUpload(projectId, { message: message.trim(), branch: branch.trim(), force })
        if (!result.pushed && result.reason === "nothing_to_upload") {
          showToast("Nothing to upload")
        } else {
          showToast(result.pushed ? "Upload complete" : "Already up to date")
        }
        setMessage("")
        onDismiss()
      } catch (err) {
        if (!aliveRef.current) return
        if (err instanceof GitOpError) {
          if (err.code === "push_rejected") {
            setConflict(true)
            return
          }
          if (err.code === "cancelled") {
            showToast("Upload cancelled")
            return
          }
          showNotice(err.message, { title: "Upload failed" })
          return
        }
        showNotice(String((err as Error)?.message ?? err), { title: "Upload failed" })
      }
    },
    [message, branch, projectId, onDismiss],
  )

  return (
    <>
      <AppDialog visible={visible} onDismiss={busy ? () => undefined : onDismiss} style={dialogLiftStyle(lift)}>
        <AppDialog.Title style={dialogCompact.title}>Upload to Git</AppDialog.Title>
        {busy ? (
          <AppDialog.Content style={dialogCompact.content}>
            <View style={styles.progressRow}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
              <Text style={{ color: theme.colors.onSurface, fontSize: fs(theme, 13), flex: 1 }} numberOfLines={2}>
                {rt?.progress || "Working…"}
              </Text>
            </View>
          </AppDialog.Content>
        ) : (
          <AppDialog.Content style={dialogCompact.content}>
            <View style={styles.form}>
              <TextInput
                ref={inputRef}
                mode="outlined"
                dense
                label="Commit message"
                value={message}
                onChangeText={setMessage}
                multiline
                numberOfLines={2}
                style={styles.field}
              />
              <TextInput
                mode="outlined"
                dense
                label="Branch"
                value={branch}
                onChangeText={setBranch}
                autoCapitalize="none"
                style={styles.field}
              />
            </View>
          </AppDialog.Content>
        )}
        <AppDialog.Actions style={dialogCompact.actions}>
          {busy ? (
            <DialogButton onPress={() => void cancelGit(projectId)}>Cancel</DialogButton>
          ) : (
            <>
              <DialogButton onPress={onDismiss}>Dismiss</DialogButton>
              <DialogButton mode="contained" onPress={() => void doUpload(false)}>
                Upload
              </DialogButton>
            </>
          )}
        </AppDialog.Actions>
      </AppDialog>
      <ConfirmDialog
        visible={conflict}
        title="Upload conflict"
        body="The remote branch has commits that are not in the local history. Force upload overwrites the remote branch, or sync first."
        confirmLabel="Force upload"
        cancelLabel="Go sync"
        danger
        onConfirm={() => {
          setConflict(false)
          void doUpload(true)
        }}
        onCancel={() => {
          setConflict(false)
          onDismiss()
          onGoSync()
        }}
      />
    </>
  )
}

const styles = StyleSheet.create({
  form: { gap: 10 },
  field: {},
  progressRow: { flexDirection: "row", alignItems: "center", gap: 10 },
})
