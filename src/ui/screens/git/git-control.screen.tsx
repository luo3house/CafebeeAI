/**
 * Project-level Git control page (the chat "+" panel Git tile lands here directly - the old
 * GitActionDialog / GitUploadDialog / GitSync page are gone). Three heading sections in order:
 * Remote (this project's single remote record summary + entry to the GitRemote CRUD page; when no remote
 * exists it becomes an [Add a remote] CTA and Pull/Push are disabled), Pull (fetch + fast-forward only),
 * Push (commit + push). The header gear first shows an explanatory ConfirmDialog, then jumps to the
 * GLOBAL Git Config hub (credentials / options / trusted hosts) - remote binding itself is project-level.
 * One operation at a time per project (serial lock): while busy, both sections' controls are disabled and
 * the inline progress+Cancel row shows in the section that started the operation. en-US copy throughout.
 */
import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native"
import { Button, Divider, IconButton, Text, TextInput, useTheme } from "react-native-paper"
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
import { ConfirmDialog } from "../../components/confirm-dialog"
import { showNotice } from "../../../state/notice"
import { showToast } from "../../../state/toast"
import { gitState } from "../../../state/git"
import { getSetup, runSync, runUpload, fetchRemoteBranches, cancelGit } from "../../../core/git"
import { GitOpError, type BranchInfo } from "react-native-pocket-git"

type Props = NativeStackScreenProps<RootStackParamList, "GitControl">

export function GitControlScreen({ navigation, route }: Props) {
  const projectId = route.params.projectId
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const snap = useSnapshot(gitState)
  const rt = snap.byProject[projectId]
  const busy = !!rt?.busy

  const [remoteUrl, setRemoteUrl] = useState<string | null>(null)
  const [remoteBranch, setRemoteBranch] = useState<string | null>(null)
  const [pullBranch, setPullBranch] = useState("main")
  const [pushBranch, setPushBranch] = useState("main")
  const [pushMessage, setPushMessage] = useState("Commit")
  const [forcePreAuth, setForcePreAuth] = useState(false)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [pullConflict, setPullConflict] = useState(false)
  const [pushRejected, setPushRejected] = useState(false)
  const [globalConfirm, setGlobalConfirm] = useState(false)
  const pullDirtyRef = useRef(false)
  const pushDirtyRef = useRef(false)
  const aliveRef = useRef(true)
  const scrollRef = useRef<ScrollView>(null)
  const pullSectionYRef = useRef(0)

  const configured = !!remoteUrl

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const loadSetup = useCallback(async () => {
    try {
      const setup = await getSetup(projectId)
      if (!aliveRef.current) return
      setRemoteUrl(setup.remoteUrl ?? null)
      setRemoteBranch(setup.branch ?? null)
      if (!pullDirtyRef.current) setPullBranch(setup.branch ?? "main")
      if (!pushDirtyRef.current) setPushBranch(setup.branch ?? "main")
    } catch {
      // read-only view of the record; a failed load leaves the "no remote" CTA state
    }
  }, [projectId])

  useEffect(() => {
    void loadSetup()
  }, [loadSetup])

  // Rule 25: the record may change on the GitRemote page - re-read when coming back
  useEffect(() => {
    const unsub = navigation.addListener("focus", () => void loadSetup())
    return unsub
  }, [navigation, loadSetup])

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => <IconButton icon="cog-outline" size={22} onPress={() => setGlobalConfirm(true)} />,
    })
  }, [navigation])

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

  const doPull = useCallback(
    async (force: boolean) => {
      if (!pullBranch.trim()) {
        showNotice("Enter a target branch.", { title: "Invalid branch" })
        return
      }
      try {
        const result = await runSync(projectId, { branch: pullBranch.trim(), force })
        showToast(result.updated ? "Pull complete" : "Already up to date")
        void loadSetup() // branch write-back updates the Remote summary (dirty fields keep the user's text)
      } catch (err) {
        if (!aliveRef.current) return
        if (err instanceof GitOpError) {
          if (err.code === "sync_conflict") {
            // Pre-authorized force skips the dialog (the checkbox itself is the confirmation).
            if (force || forcePreAuth) {
              try {
                await runSync(projectId, { branch: pullBranch.trim(), force: true })
                showToast("Forced pull complete")
              } catch (err2) {
                showNotice(err2 instanceof GitOpError ? err2.message : String((err2 as Error)?.message ?? err2), {
                  title: "Pull failed",
                })
              }
            } else {
              setPullConflict(true)
            }
            return
          }
          if (err.code === "cancelled") {
            showToast("Pull cancelled")
            return
          }
          showNotice(err.message, { title: "Pull failed" })
          return
        }
        showNotice(String((err as Error)?.message ?? err), { title: "Pull failed" })
      }
    },
    [projectId, pullBranch, forcePreAuth, loadSetup]
  )

  const doPush = useCallback(
    async (force: boolean) => {
      if (!pushMessage.trim()) {
        showNotice("Enter a commit message.", { title: "Invalid message" })
        return
      }
      if (!pushBranch.trim()) {
        showNotice("Enter a target branch.", { title: "Invalid branch" })
        return
      }
      try {
        const result = await runUpload(projectId, { message: pushMessage.trim(), branch: pushBranch.trim(), force })
        if (!result.pushed && result.reason === "nothing_to_upload") {
          showToast("Nothing to push")
        } else {
          showToast(result.pushed ? "Push complete" : "Already up to date")
        }
        setPushMessage("")
        void loadSetup() // branch write-back updates the Remote summary (dirty fields keep the user's text)
      } catch (err) {
        if (!aliveRef.current) return
        if (err instanceof GitOpError) {
          if (err.code === "push_rejected") {
            setPushRejected(true)
            return
          }
          if (err.code === "cancelled") {
            showToast("Push cancelled")
            return
          }
          showNotice(err.message, { title: "Push failed" })
          return
        }
        showNotice(String((err as Error)?.message ?? err), { title: "Push failed" })
      }
    },
    [projectId, pushMessage, pushBranch, loadSetup]
  )

  const goToPullSection = useCallback(() => {
    setPushRejected(false)
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: Math.max(0, pullSectionYRef.current - 8), animated: true })
    })
  }, [])

  const renderProgress = (kind: "sync" | "upload") =>
    busy && rt?.kind === kind ? (
      <View style={[styles.progressRow, { backgroundColor: theme.colors.surfaceVariant }]}>
        <ActivityIndicator size="small" color={theme.colors.primary} />
        <Text style={{ color: theme.colors.onSurface, fontSize: fs(theme, 13), flex: 1 }} numberOfLines={2}>
          {rt?.progress || "Working…"}
        </Text>
        <Button compact mode="text" onPress={() => void cancelGit(projectId)}>
          Cancel
        </Button>
      </View>
    ) : null

  return (
    <>
      <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={[styles.content, { paddingBottom: 24 + insets.bottom }]}>
        <Text style={[styles.sectionTitle, { color: theme.colors.onSurface, fontSize: fs(theme, 15) }]}>Remote</Text>
        {configured ? (
          <>
            <View style={[styles.remoteCard, { backgroundColor: theme.colors.surfaceVariant }]}>
              <Text style={{ color: theme.colors.onSurface, fontSize: fs(theme, 13) }} numberOfLines={1}>
                {"origin · " + (remoteUrl ?? "")}
              </Text>
              <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }} numberOfLines={1}>
                {"Default branch: " + (remoteBranch ?? "main")}
              </Text>
            </View>
            <Button mode="outlined" icon="pencil-outline" disabled={busy} onPress={() => navigation.navigate("GitRemote", { projectId })}>
              Manage remote
            </Button>
          </>
        ) : (
          <>
            <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }}>
              No remote repository is set up for this project yet. Pull and Push stay unavailable until one is added.
            </Text>
            <Button mode="contained" icon="plus" onPress={() => navigation.navigate("GitRemote", { projectId })}>
              Add a remote
            </Button>
          </>
        )}

        <Divider style={styles.divider} />

        <View
          onLayout={(e) => {
            pullSectionYRef.current = e.nativeEvent.layout.y
          }}
        >
          <Text style={[styles.sectionTitle, { color: theme.colors.onSurface, fontSize: fs(theme, 15) }]}>Pull</Text>
          <TextInput
            mode="outlined"
            dense
            label="Target branch"
            value={pullBranch}
            onChangeText={(t) => {
              pullDirtyRef.current = true
              setPullBranch(t)
            }}
            autoCapitalize="none"
            disabled={busy || !configured}
          />
          <CheckRow
            checked={forcePreAuth}
            disabled={busy || !configured}
            title="Force pull"
            description="On conflict, overwrite local state with the remote branch without asking."
            onPress={() => setForcePreAuth((v) => !v)}
          />
          <View style={styles.row}>
            <Button
              mode="outlined"
              compact
              icon="database-search"
              disabled={busy || !configured || rt?.branchesLoading}
              loading={!!rt?.branchesLoading}
              onPress={() => void doFetchBranches()}
            >
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
                <AppPressable
                  key={b.name}
                  disabled={busy || !configured}
                  pressedStyle={{ backgroundColor: theme.colors.primaryContainer }}
                  onPress={() => {
                    pullDirtyRef.current = true
                    setPullBranch(b.name)
                  }}
                >
                  {i > 0 ? <Divider /> : null}
                  <View style={styles.tr}>
                    <Text
                      style={{
                        color: pullBranch === b.name ? theme.colors.onPrimaryContainer : theme.colors.onSurface,
                        fontSize: fs(theme, 13),
                        flex: 1,
                        fontWeight: pullBranch === b.name ? "bold" : "normal",
                      }}
                      numberOfLines={1}
                    >
                      {b.name}
                    </Text>
                    <Text style={[styles.tdSha, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }]}>{b.sha.slice(0, 7)}</Text>
                  </View>
                </AppPressable>
              ))}
            </View>
          ) : (
            <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }}>
              {rt?.branchesLoading ? "Loading remote branches…" : configured ? "Fetch to pick a remote branch, or type it manually." : ""}
            </Text>
          )}
          {renderProgress("sync")}
          <Button mode="contained" icon="download" disabled={busy || !configured} loading={busy && rt?.kind === "sync"} onPress={() => void doPull(forcePreAuth)}>
            Pull
          </Button>
          <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }}>
            {
              "Pull never creates merge commits. Local changes that would be overwritten block the pull; save them with a push first, or force pull to adopt the remote state wholesale."
            }
          </Text>
        </View>

        <Divider style={styles.divider} />

        <Text style={[styles.sectionTitle, { color: theme.colors.onSurface, fontSize: fs(theme, 15) }]}>Push</Text>
        <TextInput mode="outlined" dense label="Commit message" value={pushMessage} onChangeText={setPushMessage} multiline numberOfLines={2} disabled={busy || !configured} />
        <TextInput
          mode="outlined"
          dense
          label="Branch"
          value={pushBranch}
          onChangeText={(t) => {
            pushDirtyRef.current = true
            setPushBranch(t)
          }}
          autoCapitalize="none"
          disabled={busy || !configured}
        />
        {renderProgress("upload")}
        <Button mode="contained" icon="upload" disabled={busy || !configured} loading={busy && rt?.kind === "upload"} onPress={() => void doPush(false)}>
          Push
        </Button>
        <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }}>{"Push commits all project changes and uploads them to the remote branch."}</Text>
      </ScrollView>

      <AppDialog visible={pullConflict} onDismiss={() => setPullConflict(false)} style={styles.dialog}>
        <AppDialog.Title style={dialogCompact.title}>Pull conflict</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <Text style={{ color: theme.colors.onSurfaceVariant }}>
            The pull was aborted. Local and remote histories differ, or local changes block the update. Force pull overwrites the local state with the remote branch.
          </Text>
        </AppDialog.Content>
        <AppDialog.Actions style={styles.verticalActions}>
          <DialogButton
            style={styles.wideBtn}
            mode="contained"
            onPress={() => {
              setPullConflict(false)
              void doPull(true)
            }}
          >
            Force pull
          </DialogButton>
          <DialogButton style={styles.wideBtn} onPress={() => setPullConflict(false)}>
            Switch branch
          </DialogButton>
          <DialogButton style={styles.wideBtn} onPress={() => setPullConflict(false)}>
            Cancel
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>

      <ConfirmDialog
        visible={pushRejected}
        title="Push rejected"
        body="The remote branch has commits that are not in the local history. Force push overwrites the remote branch, or pull first."
        confirmLabel="Force push"
        cancelLabel="Go pull"
        danger
        onConfirm={() => {
          setPushRejected(false)
          void doPush(true)
        }}
        onCancel={goToPullSection}
      />

      <ConfirmDialog
        visible={globalConfirm}
        title="Open global Git settings?"
        body="Git credentials, options and trusted hosts are configured there. The remote for this project is managed under the Remote section."
        confirmLabel="Open"
        cancelLabel="Cancel"
        onConfirm={() => {
          setGlobalConfirm(false)
          navigation.navigate("GitConfig")
        }}
        onCancel={() => setGlobalConfirm(false)}
      />
    </>
  )
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 8 },
  sectionTitle: { letterSpacing: 0.2, fontWeight: "bold", marginTop: 2 },
  remoteCard: { borderRadius: 8, padding: 12, gap: 2 },
  divider: { marginTop: 14, marginBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  table: { borderRadius: 8, overflow: "hidden" },
  tr: { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 12 },
  th: { paddingVertical: 8 },
  td: { flex: 1 },
  tdSha: { width: 84, textAlign: "right" },
  progressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: 8,
  },
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
