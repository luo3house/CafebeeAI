/**
 * Project-level Git setup page (the [Settings] entry from the chat "+" Git tile): binds this Project's
 * workspace to ONE remote (URL + credential + default branch). Secrets stay in EncryptedStorage (the picker
 * only stores the credential id); URLs with embedded credentials are refused here and natively (rule: no
 * tokens in .git/config / export packages).
 */
import React, { useCallback, useEffect, useRef, useState } from "react"
import { ScrollView, StyleSheet, View } from "react-native"
import { Button, Divider, Menu, Text, TextInput, useTheme } from "react-native-paper"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { RootStackParamList } from "../../../app/app.ui.navigator"
import { fs } from "../../../app/app.ui.theme"
import { AppDialog } from "../../components/app-dialog"
import { dialogCompact } from "../../components/dialog-compact"
import { DialogButton } from "../../components/dialog-button"
import { dialogLiftStyle, useKeyboardLift } from "../../use-keyboard-lift"
import { showNotice } from "../../../state/notice"
import { showToast } from "../../../state/toast"
import { getSetup, saveSetup } from "../../../core/git"
import {
  kGitCredentialStore,
  credentialTypeLabel,
  credentialTypeIcon,
  hostOfUrl,
  credMatchesHost,
  sortCredsForHost,
  type GitCredentialMeta,
} from "../../../core/git-credentials"

type Props = NativeStackScreenProps<RootStackParamList, "GitSetup">

const EMBEDDED_CREDENTIALS_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/@]+@/i

export function GitSetupScreen({ navigation, route }: Props) {
  const projectId = route.params.projectId
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const lift = useKeyboardLift()

  const [remoteUrl, setRemoteUrl] = useState("")
  const [branch, setBranch] = useState("main")
  const [credId, setCredId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [clearConfirm, setClearConfirm] = useState(false)
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
    if (url) {
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
    }
    if (!branch.trim()) {
      showNotice("Enter a default branch.", { title: "Invalid branch" })
      return
    }
    await saveSetup(projectId, {
      remoteUrl: url || undefined,
      branch: branch.trim(),
      credId: credId ?? undefined,
    })
    showToast(url ? "Git setup saved" : "Git remote cleared for this project")
    navigation.goBack()
  }, [remoteUrl, branch, credId, projectId, navigation])

  return (
    <>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.content, { paddingBottom: 24 + insets.bottom }]}>
        <Text style={[styles.help, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }]}>
          This Project uploads to and syncs with one remote branch. Leave the URL empty and save to unlink (the local repository stays untouched).
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
        <TextInput
          mode="outlined"
          dense
          label="Default branch"
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
            {selectedMismatched ? `Hint: this credential is for ${selected?.hostPrefix} remotes` : "Credential used for this remote"}
          </Text>
        </View>
        <Button mode="contained" icon="check" onPress={() => void onSave()} style={styles.saveBtn}>
          Save
        </Button>
        {remoteUrl.trim() ? (
          <Button mode="text" compact textColor={theme.colors.error} onPress={() => setClearConfirm(true)} style={styles.clearBtn}>
            Clear remote for this project
          </Button>
        ) : null}
      </ScrollView>
      <AppDialog visible={clearConfirm} onDismiss={() => setClearConfirm(false)} style={dialogLiftStyle(lift)}>
        <AppDialog.Title style={dialogCompact.title}>Clear remote?</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <Text style={{ color: theme.colors.onSurface }}>
            Upload and sync will be hidden in the Git menu until a remote is set again. The local repository and its history stay untouched.
          </Text>
        </AppDialog.Content>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => setClearConfirm(false)}>Cancel</DialogButton>
          <DialogButton
            mode="contained"
            buttonColor={theme.colors.error}
            textColor={theme.colors.onError}
            onPress={async () => {
              setClearConfirm(false)
              setRemoteUrl("")
              await saveSetup(projectId, { remoteUrl: undefined })
              showToast("Git remote cleared for this project")
            }}
          >
            Clear
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>
    </>
  )
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  help: {},
  field: {},
  credRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  saveBtn: { marginTop: 6 },
  clearBtn: { alignSelf: "center" },
})
