/**
 * Project-level Remote CRUD page (entered from the Remote section of the Git control page): this Project
 * holds at most ONE remote record - the fixed-name origin remote bound to the workspace (URL + credential +
 * default branch), stored in the project-meta config.yaml git segment; with no record the same form is the
 * create state. Secrets stay in EncryptedStorage (rule 29): the picker only stores the credential id; URLs
 * with embedded credentials are refused here and natively (rule: no tokens in .git/config / export packages).
 * Deleting the record is the destructive action (danger confirm, local repository and history untouched) -
 * saving with an empty URL is not a delete shortcut (URL is required).
 */
import React, { useCallback, useEffect, useRef, useState } from "react"
import { ScrollView, StyleSheet, View } from "react-native"
import { Button, Divider, Menu, Text, TextInput, useTheme } from "react-native-paper"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { RootStackParamList } from "../../../app/app.ui.navigator"
import { fs } from "../../../app/app.ui.theme"
import { ConfirmDialog } from "../../components/confirm-dialog"
import { showNotice } from "../../../state/notice"
import { showToast } from "../../../state/toast"
import { getSetup, saveSetup, deleteRemote } from "../../../core/git"
import {
  kGitCredentialStore,
  credentialTypeLabel,
  credentialTypeIcon,
  hostOfUrl,
  credMatchesHost,
  sortCredsForHost,
  type GitCredentialMeta,
} from "../../../core/git-credentials"

type Props = NativeStackScreenProps<RootStackParamList, "GitRemote">

const EMBEDDED_CREDENTIALS_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/@]+@/i

export function GitRemoteScreen({ navigation, route }: Props) {
  const projectId = route.params.projectId
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  const [existing, setExisting] = useState(false)
  const [remoteUrl, setRemoteUrl] = useState("")
  const [branch, setBranch] = useState("main")
  const [credId, setCredId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [credsVersion, setCredsVersion] = useState(0)
  void credsVersion
  useEffect(() => {
    const unsub = navigation.addListener("focus", () => setCredsVersion((v) => v + 1))
    return unsub
  }, [navigation])

  const creds: GitCredentialMeta[] = kGitCredentialStore().list()
  const selected = credId ? creds.find((c) => c.id === credId) : undefined
  const urlHost = hostOfUrl(remoteUrl)
  const sortedCreds = sortCredsForHost(creds, urlHost)
  const selectedMismatched = !!selected && !!urlHost && !!selected.hostPrefix && !credMatchesHost(selected, urlHost)

  // host_prefix soft filter (Q12): when the URL host changes and no credential is bound yet, default to the
  // single host-matching credential; ambiguous matches and any existing choice are never overridden.
  const appliedHostRef = useRef<string | null>(null)
  useEffect(() => {
    const host = hostOfUrl(remoteUrl)
    if (appliedHostRef.current === host) return
    appliedHostRef.current = host
    if (credId) return
    const matches = creds.filter((c) => credMatchesHost(c, host))
    if (matches.length === 1) setCredId(matches[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteUrl, credId])

  useEffect(() => {
    let alive = true
    void getSetup(projectId).then((setup) => {
      if (!alive) return
      setExisting(!!setup.remoteUrl)
      setRemoteUrl(setup.remoteUrl ?? "")
      setBranch(setup.branch ?? "main")
      setCredId(setup.credId ?? null)
    })
    return () => {
      alive = false
    }
  }, [projectId])

  const onSave = useCallback(async () => {
    const url = remoteUrl.trim()
    if (!url) {
      showNotice("Enter a repository URL (https://… or git@host:…).", { title: "Invalid URL" })
      return
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\/|^[^/@\s]+@[^/@\s]+:/i.test(url)) {
      showNotice("Enter a valid repository URL (https://… or git@host:…).", { title: "Invalid URL" })
      return
    }
    if (EMBEDDED_CREDENTIALS_RE.test(url)) {
      showNotice(
        "URLs with embedded credentials are not supported. Remove the user info and pick a credential instead.",
        { title: "Invalid URL" },
      )
      return
    }
    if (!branch.trim()) {
      showNotice("Enter a default branch.", { title: "Invalid branch" })
      return
    }
    await saveSetup(projectId, {
      remoteUrl: url,
      branch: branch.trim(),
      credId,
    })
    showToast(existing ? "Remote updated" : "Remote added")
    navigation.goBack()
  }, [remoteUrl, branch, credId, existing, projectId, navigation])

  const onDelete = useCallback(async () => {
    setDeleteConfirm(false)
    await deleteRemote(projectId)
    showToast("Remote deleted")
    navigation.goBack()
  }, [projectId, navigation])

  return (
    <>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.content, { paddingBottom: 24 + insets.bottom }]}>
        <Text style={[styles.help, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }]}>
          {
            "This Project pulls from and pushes to one remote repository (stored as the standard origin remote). Switching to another repository means editing this record."
          }
        </Text>
        <TextInput
          mode="outlined"
          dense
          label="Remote URL"
          value={remoteUrl}
          onChangeText={setRemoteUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="https://github.com/user/repo.git"
        />
        <TextInput mode="outlined" dense label="Default branch" value={branch} onChangeText={setBranch} autoCapitalize="none" style={styles.field} />
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
            {selectedMismatched ? `Hint: this credential is for ${selected?.hostPrefix} remotes` : "Credential used for this remote"}
          </Text>
        </View>
        <Button mode="contained" icon="content-save" onPress={() => void onSave()} style={styles.saveBtn}>
          {existing ? "Save changes" : "Add remote"}
        </Button>
        {existing ? (
          <Button mode="text" compact icon="trash-can-outline" textColor={theme.colors.error} onPress={() => setDeleteConfirm(true)} style={styles.deleteBtn}>
            Delete remote
          </Button>
        ) : null}
      </ScrollView>
      <ConfirmDialog
        visible={deleteConfirm}
        title="Delete remote?"
        body="Pull and Push stay unavailable until a remote is added again. The local repository and its history stay untouched."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onConfirm={() => void onDelete()}
        onCancel={() => setDeleteConfirm(false)}
      />
    </>
  )
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  help: {},
  field: {},
  credRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  saveBtn: { marginTop: 6 },
  deleteBtn: { alignSelf: "center" },
})
