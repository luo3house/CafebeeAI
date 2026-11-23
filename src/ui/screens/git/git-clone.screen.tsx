/**
 * Git clone page (reaches from the empty-project wizard): URL + credential picker + optional branch.
 * Progress runs inside a cancellable AppDialog; clone lands in this (empty) project root - the native
 * side refuses non-empty projects, cancel/failure leaves the directory as-is (nothing half-populated
 * except an initialized empty repo, which the next clone/upload will reuse).
 */
import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native"
import { Button, Divider, Menu, Text, TextInput, useTheme } from "react-native-paper"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useSnapshot } from "valtio"
import type { RootStackParamList } from "../../../app/app.ui.navigator"
import { fs } from "../../../app/app.ui.theme"
import { AppDialog } from "../../components/app-dialog"
import { dialogCompact } from "../../components/dialog-compact"
import { DialogButton } from "../../components/dialog-button"
import { useModalInputFocus } from "../../use-modal-input-focus"
import { useKeyboardLift } from "../../use-keyboard-lift"
import { showNotice } from "../../../state/notice"
import { showToast } from "../../../state/toast"
import { gitState } from "../../../state/git"
import { getSetup, runClone, cancelGit, validateRemoteUrl } from "../../../core/git"
import {
  kGitCredentialStore,
  credentialTypeLabel,
  credentialTypeIcon,
  hostOfUrl,
  credMatchesHost,
  sortCredsForHost,
  type GitCredentialMeta,
} from "../../../core/git-credentials"
import { GitOpError } from "react-native-pocket-git"

type Props = NativeStackScreenProps<RootStackParamList, "GitClone">

export function GitCloneScreen({ navigation, route }: Props) {
  const projectId = route.params.projectId
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const keyboardLift = useKeyboardLift()
  const inputRef = useModalInputFocus(true)
  const snap = useSnapshot(gitState)
  const rt = snap.byProject[projectId]
  const busy = !!rt?.busy && rt?.kind === "clone"

  const [url, setUrl] = useState("")
  const [branch, setBranch] = useState("main")
  const [credId, setCredId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const creds: GitCredentialMeta[] = kGitCredentialStore().list()
  const selected = credId ? creds.find((c) => c.id === credId) : undefined
  const urlHost = hostOfUrl(url)
  const sortedCreds = sortCredsForHost(creds, urlHost)
  const selectedMismatched = !!selected && !!urlHost && !!selected.hostPrefix && !credMatchesHost(selected, urlHost)

  // host_prefix soft filter (Q12): default to the single host-matching credential when the URL host changes
  // and nothing is bound yet; never override an existing choice, never pick among ambiguous matches.
  const appliedHostRef = useRef<string | null>(null)
  useEffect(() => {
    const host = hostOfUrl(url)
    if (appliedHostRef.current === host) return
    appliedHostRef.current = host
    if (credId) return
    const matches = creds.filter((c) => credMatchesHost(c, host))
    if (matches.length === 1) setCredId(matches[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, credId])

  useEffect(() => {
    let alive = true
    void getSetup(projectId).then((setup) => {
      if (alive && setup.credId) setCredId(setup.credId)
    })
    return () => {
      alive = false
    }
  }, [projectId])

  const doClone = useCallback(async () => {
    const problem = validateRemoteUrl(url.trim())
    if (problem) {
      showNotice(problem, { title: "Invalid URL" })
      return
    }
    try {
      await runClone(projectId, { url: url.trim(), branch: branch.trim() || "main", credId })
      showToast("Clone complete")
      navigation.goBack()
    } catch (err) {
      if (err instanceof GitOpError) {
        if (err.code === "cancelled") {
          showToast("Clone cancelled")
          return
        }
        showNotice(err.message, { title: "Clone failed" })
        return
      }
      showNotice(String((err as Error)?.message ?? err), { title: "Clone failed" })
    }
  }, [url, branch, credId, projectId, navigation])

  return (
    <>
      <View style={{ flex: 1, marginBottom: keyboardLift }} pointerEvents="box-none">
        <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.content, { paddingBottom: 24 + insets.bottom }]} keyboardShouldPersistTaps="handled">
          <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }}>
            Clone fills this project with the remote repository. The project must be empty.
          </Text>
          <TextInput
            ref={inputRef}
            mode="outlined"
            dense
            label="Repository URL"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="https://github.com/user/repo.git"
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
          <View style={styles.credRow}>
            <Menu
              visible={menuOpen}
              onDismiss={() => setMenuOpen(false)}
              anchor={
                <Button mode="outlined" compact icon="key-variant" onPress={() => setMenuOpen(true)}>
                  {selected ? selected.name : "None"}
                </Button>
              }
              contentStyle={{ maxHeight: 320 }}
            >
              <Menu.Item title="None" onPress={() => { setMenuOpen(false); setCredId(null) }} />
              <Divider />
              {sortedCreds.map((c) => (
                <Menu.Item
                  key={c.id}
                  title={c.name + " · " + credentialTypeLabel(c)}
                  leadingIcon={credentialTypeIcon(c)}
                  onPress={() => {
                    setMenuOpen(false)
                    setCredId(c.id)
                  }}
                />
              ))}
              <Divider />
              <Menu.Item title="Manage credentials…" leadingIcon="cog-outline" onPress={() => { setMenuOpen(false); navigation.navigate("GitCredentials") }} />
            </Menu>
            <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12), flex: 1 }} numberOfLines={2}>
              {selectedMismatched ? `Hint: this credential is for ${selected?.hostPrefix} remotes` : "Credential for private repositories"}
            </Text>
          </View>
          <Button mode="contained" icon="download" loading={busy} disabled={busy} onPress={() => void doClone()}>
            Clone
          </Button>
        </ScrollView>
      </View>
      <AppDialog visible={busy} onDismiss={() => undefined}>
        <AppDialog.Title style={dialogCompact.title}>Cloning…</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <View style={styles.progressRow}>
            <ActivityIndicator size="small" color={theme.colors.primary} />
            <Text style={{ color: theme.colors.onSurface, fontSize: fs(theme, 13), flex: 1 }} numberOfLines={2}>
              {rt?.progress || "Connecting…"}
            </Text>
          </View>
        </AppDialog.Content>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => void cancelGit(projectId)}>Cancel</DialogButton>
        </AppDialog.Actions>
      </AppDialog>
    </>
  )
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  field: {},
  credRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 10 },
})
