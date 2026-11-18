/**
 * Sync page (pull): branch field (remembered) + "Fetch branches" renders the remote branch list as a
 * markdown-styled selectable table kept in memory only + pre-authorized "Force sync" checkbox.
 * Sync is fetch + fast-forward only; a conflict aborts cleanly (nothing half-applied by construction),
 * then the dialog offers [Force sync]/[Switch branch]/[Cancel] - resolution editing is out of scope (consensus).
 */
import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native"
import { Button, Divider, Text, TextInput, useTheme } from "react-native-paper"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useSnapshot } from "valtio"
import type { RootStackParamList } from "../../../app/app.ui.navigator"
import { fs } from "../../../app/app.ui.theme"
import { AppPressable } from "../../components/app-pressable"
import { CheckRow } from "../../components/option-row"
import { AppDialog } from "../../components/app-dialog"
import { dialogCompact } from "../../components/dialog-compact"
import { DialogButton } from "../../components/dialog-button"
import { showNotice } from "../../../state/notice"
import { showToast } from "../../../state/toast"
import { gitState } from "../../../state/git"
import { getSetup, runSync, fetchRemoteBranches, cancelGit } from "../../../core/git"
import { GitOpError, type BranchInfo } from "react-native-pocket-git"

type Props = NativeStackScreenProps<RootStackParamList, "GitSync">

export function GitSyncScreen({ route }: Props) {
  const projectId = route.params.projectId
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const snap = useSnapshot(gitState)
  const rt = snap.byProject[projectId]
  const busy = !!rt?.busy

  const [branch, setBranch] = useState("main")
  const [forcePreAuth, setForcePreAuth] = useState(false)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [conflict, setConflict] = useState(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    void getSetup(projectId).then((setup) => {
      if (alive && setup.branch) setBranch(setup.branch)
    })
    return () => {
      alive = false
    }
  }, [projectId])

  const doFetchBranches = useCallback(async () => {
    try {
      const list = await fetchRemoteBranches(projectId)
      setBranches([...list].sort((a, b) => a.name.localeCompare(b.name)))
    } catch (err) {
      showNotice(err instanceof GitOpError ? err.message : String((err as Error)?.message ?? err), {
        title: "Could not list remote branches",
      })
    }
  }, [projectId])

  const run = useCallback(
    async (force: boolean) => {
      if (!branch.trim()) {
        showNotice("Enter a target branch.", { title: "Invalid branch" })
        return
      }
      try {
        const result = await runSync(projectId, { branch: branch.trim(), force })
        showToast(result.updated ? "Sync complete" : "Already up to date")
      } catch (err) {
        if (!aliveRef.current) return
        if (err instanceof GitOpError) {
          if (err.code === "sync_conflict") {
            // Pre-authorized force skips the dialog (the checkbox itself is the confirmation).
            if (force || forcePreAuth) {
              try {
                await runSync(projectId, { branch: branch.trim(), force: true })
                showToast("Forced sync complete")
              } catch (err2) {
                showNotice(err2 instanceof GitOpError ? err2.message : String((err2 as Error)?.message ?? err2), {
                  title: "Sync failed",
                })
              }
            } else {
              setConflict(true)
            }
            return
          }
          if (err.code === "cancelled") {
            showToast("Sync cancelled")
            return
          }
          showNotice(err.message, { title: "Sync failed" })
          return
        }
        showNotice(String((err as Error)?.message ?? err), { title: "Sync failed" })
      }
    },
    [branch, forcePreAuth, projectId]
  )

  return (
    <>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.content, { paddingBottom: 24 + insets.bottom }]}>
        <Text style={[styles.label, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }]}>TARGET BRANCH</Text>
        <TextInput mode="outlined" dense label="Branch" value={branch} onChangeText={setBranch} autoCapitalize="none" disabled={busy} style={styles.field} />

        <CheckRow
          checked={forcePreAuth}
          disabled={busy}
          title="Force sync"
          description="On conflict, overwrite local state with the remote branch without asking."
          onPress={() => setForcePreAuth((v) => !v)}
        />
        <View style={styles.row}>
          <Button mode="outlined" compact icon="database-search" disabled={busy || rt?.branchesLoading} loading={!!rt?.branchesLoading} onPress={() => void doFetchBranches()}>
            Fetch remote branches
          </Button>
        </View>
        {branches.length > 0 ? (
          <View style={[styles.table, { backgroundColor: theme.colors.surfaceVariant }]}>
            <View style={[styles.tr, styles.th]}>
              <Text style={[styles.td, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 11) }]}>BRANCH</Text>
              <Text style={[styles.tdSha, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 11) }]}>COMMIT</Text>
            </View>
            <Divider />
            {branches.map((b, i) => (
              <AppPressable key={b.name} pressedStyle={{ backgroundColor: theme.colors.primaryContainer }} onPress={() => setBranch(b.name)}>
                {i > 0 ? <Divider /> : null}
                <View style={styles.tr}>
                  <Text style={[styles.td, { color: theme.colors.onSurface, fontSize: fs(theme, 13) }]} numberOfLines={1}>
                    {b.name}
                  </Text>
                  <Text style={[styles.tdSha, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }]}>{b.sha.slice(0, 7)}</Text>
                </View>
              </AppPressable>
            ))}
          </View>
        ) : (
          <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12), marginTop: 8 }}>
            {rt?.branchesLoading ? "Loading remote branches…" : "Fetch to pick a remote branch, or type it manually."}
          </Text>
        )}
        {busy ? (
          <View style={[styles.progressRow, { backgroundColor: theme.colors.surfaceVariant }]}>
            <ActivityIndicator size="small" color={theme.colors.primary} />
            <Text style={{ color: theme.colors.onSurface, fontSize: fs(theme, 13), flex: 1 }} numberOfLines={2}>
              {rt?.progress || "Working…"}
            </Text>
            <Button compact mode="text" onPress={() => void cancelGit(projectId)}>
              Cancel
            </Button>
          </View>
        ) : null}
        <Button mode="contained" icon="download" disabled={busy} loading={busy} onPress={() => void run(forcePreAuth)} style={styles.syncBtn}>
          Sync
        </Button>
        <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12), marginTop: 10 }}>
          {
            "Sync never creates merge commits. Local changes that would be overwritten block the sync; resolve them with an upload first, or force sync to adopt the remote state wholesale."
          }
        </Text>
      </ScrollView>
      <AppDialog visible={conflict} onDismiss={() => setConflict(false)} style={styles.dialog}>
        <AppDialog.Title style={dialogCompact.title}>Sync conflict</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <Text style={{ color: theme.colors.onSurfaceVariant }}>
            The sync was aborted. Local and remote histories differ, or local changes block the update. Force sync overwrites the local state with the remote branch.
          </Text>
        </AppDialog.Content>
        <AppDialog.Actions style={styles.verticalActions}>
          <DialogButton
            style={styles.wideBtn}
            mode="contained"
            onPress={() => {
              setConflict(false)
              void run(true)
            }}
          >
            Force sync
          </DialogButton>
          <DialogButton style={styles.wideBtn} onPress={() => setConflict(false)}>
            Switch branch
          </DialogButton>
          <DialogButton style={styles.wideBtn} onPress={() => setConflict(false)}>
            Cancel
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>
    </>
  )
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 8 },
  label: { letterSpacing: 0.6, marginTop: 6 },
  field: {},
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 4 },
  table: { marginTop: 10, borderRadius: 8, overflow: "hidden" },
  tr: { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 12 },
  th: { paddingVertical: 8 },
  td: { flex: 1 },
  tdSha: { width: 84, textAlign: "right" },
  progressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
  },
  syncBtn: { marginTop: 14 },
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
