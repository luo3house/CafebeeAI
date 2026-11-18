/**
 * Global Git credentials page (Settings > Global Git Config > Git Credentials): CRUD for named credentials
 * (username+password / personal access token / SSH key pair) shared by all projects. Secret halves go to
 * EncryptedStorage (rule 29).
 *
 * Entry model (rule 30 + Q16): the "+" button opens a minimal pre-dialog carrying only the
 * "Generate key pair (ed25519)" checkbox; Next opens the full-screen TextEditor with the UNIFIED YAML template
 * (core/git-cred-yaml.ts: three `uses_*` blocks, exactly one filled). Generation prefills the SSH block with the
 * PEM pair; the key is visible/copyable in the editor, so there is no post-save preview dialog. Create and edit
 * both go through the TextEditor; `parseCredYaml` is the validate step and `onSave` writes kGitCredentialStore.
 */
import React, { useCallback, useLayoutEffect, useState } from "react"
import { FlatList, RefreshControl, StyleSheet, View } from "react-native"
import { Card, IconButton, List, Text, useTheme } from "react-native-paper"
import { useFocusEffect } from "@react-navigation/native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Config from "react-native-config"
import { APP_NAME } from "../../../app/app.constants"
import { fs } from "../../../app/app.ui.theme"
import { AppDialog } from "../../components/app-dialog"
import { dialogCompact } from "../../components/dialog-compact"
import { DialogButton } from "../../components/dialog-button"
import { ConfirmDialog } from "../../components/confirm-dialog"
import { CheckRow } from "../../components/option-row"
import { showNotice } from "../../../state/notice"
import { showToast } from "../../../state/toast"
import {
  kGitCredentialStore,
  credentialTypeLabel,
  credentialTypeIcon,
  type GitCredentialMeta,
} from "../../../core/git-credentials"
import { parseCredYaml, credTemplate, renderCredYaml, type UnifiedCredDoc } from "../../../core/git-cred-yaml"
import { generateSshKey } from "react-native-pocket-git"

interface TypeChoice {
  generate: boolean
}

function subtitleOf(meta: GitCredentialMeta): string {
  return [meta.hostPrefix, credentialTypeLabel(meta), meta.username].filter(Boolean).join(" · ")
}

export function GitCredentialsScreen({ navigation }: { navigation: any }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [creds, setCreds] = useState<GitCredentialMeta[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [choice, setChoice] = useState<TypeChoice | null>(null)
  const [generating, setGenerating] = useState(false)
  const [deleting, setDeleting] = useState<GitCredentialMeta | null>(null)

  const refresh = useCallback(() => setCreds(kGitCredentialStore().list()), [])
  useFocusEffect(refresh)

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <IconButton icon="plus" size={22} onPress={() => setChoice({ generate: false })} />,
    })
  }, [navigation])

  const openEditor = (opts: { key?: { publicLine: string; privatePem: string }; editId?: string; doc?: UnifiedCredDoc }) => {
    const editing = !!opts.editId
    navigation.navigate("TextEditor", {
      label: editing ? "Edit credential" : "New credential",
      initialText: opts.doc ? renderCredYaml(opts.doc) : credTemplate(opts.key),
      validate: async (text: string) => parseCredYaml(text),
      onSave: async (value: unknown) => {
        const doc = value as UnifiedCredDoc
        try {
          const common = {
            name: doc.name,
            type: doc.kind,
            hostPrefix: doc.hostPrefix ?? "",
            username: doc.kind === "sshKey" ? doc.sshUser ?? "" : doc.username,
            publicKey: doc.kind === "sshKey" ? doc.publicKey : "",
            secret:
              doc.kind === "sshKey"
                ? { privatePem: doc.privateKey, passphrase: doc.passphrase }
                : { password: doc.kind === "accessToken" ? doc.token : doc.password },
          }
          if (opts.editId) await kGitCredentialStore().update(opts.editId, common)
          else await kGitCredentialStore().create(common)
          showToast("Credential saved")
          refresh()
        } catch (err) {
          showNotice(String((err as Error)?.message ?? err), { title: "Save failed" })
          throw err
        }
      },
    })
  }

  const proceedFromChoice = async () => {
    if (!choice) return
    if (!choice.generate) {
      setChoice(null)
      openEditor({})
      return
    }
    setGenerating(true)
    try {
      const key = await generateSshKey({ type: "ed25519", comment: `${(Config.APP_NAME || APP_NAME).toLowerCase()}-android` })
      setChoice(null)
      openEditor({ key: { publicLine: key.publicLine, privatePem: key.privatePem } })
    } catch (err) {
      showNotice(String((err as Error)?.message ?? err), { title: "Key generation failed" })
    } finally {
      setGenerating(false)
    }
  }

  const startEdit = async (meta: GitCredentialMeta) => {
    const secret = await kGitCredentialStore().secretOf(meta.id)
    if (meta.type === "sshKey") {
      openEditor({
        editId: meta.id,
        doc: {
          kind: "sshKey",
          name: meta.name,
          hostPrefix: meta.hostPrefix,
          sshUser: meta.username,
          passphrase: secret?.passphrase,
          publicKey: meta.publicKey ?? "",
          privateKey: secret?.privatePem ?? "",
        },
      })
      return
    }
    if (meta.type === "accessToken") {
      openEditor({
        editId: meta.id,
        doc: {
          kind: "accessToken",
          name: meta.name,
          hostPrefix: meta.hostPrefix,
          username: meta.username ?? "",
          token: secret?.password ?? "",
        },
      })
      return
    }
    openEditor({
      editId: meta.id,
      doc: {
        kind: "userpass",
        name: meta.name,
        hostPrefix: meta.hostPrefix,
        username: meta.username ?? "",
        password: secret?.password ?? "",
      },
    })
  }

  const doDelete = async () => {
    if (!deleting) return
    await kGitCredentialStore().remove(deleting.id)
    setDeleting(null)
    showToast("Credential deleted")
    refresh()
  }

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      <FlatList
        data={creds}
        keyExtractor={(c) => c.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true)
              refresh()
              setRefreshing(false)
            }}
          />
        }
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 14) }]}>
            No credentials yet. Add a username + password, a personal access token, or an SSH key pair.
          </Text>
        }
        renderItem={({ item }) => (
          <Card style={styles.card}>
            <Card.Title
              title={item.name}
              titleNumberOfLines={1}
              subtitle={subtitleOf(item)}
              subtitleNumberOfLines={1}
              left={(props) => <List.Icon {...props} icon={credentialTypeIcon(item)} />}
              right={() => (
                <View style={styles.cardActions}>
                  <IconButton icon="pencil-outline" size={20} onPress={() => void startEdit(item)} />
                  <IconButton icon="delete-outline" size={20} onPress={() => setDeleting(item)} />
                </View>
              )}
            />
          </Card>
        )}
      />
      <AppDialog visible={choice !== null} onDismiss={() => setChoice(null)}>
        {choice ? (
          <>
            <AppDialog.Title style={dialogCompact.title}>New credential</AppDialog.Title>
            <AppDialog.Content style={dialogCompact.content}>
              <CheckRow
                checked={choice.generate}
                disabled={generating}
                title="Generate key pair (ed25519)"
                onPress={() => setChoice({ ...choice, generate: !choice.generate })}
              />
            </AppDialog.Content>
            <AppDialog.Actions style={dialogCompact.actions}>
              <DialogButton onPress={() => setChoice(null)} disabled={generating}>
                Cancel
              </DialogButton>
              <DialogButton mode="contained" loading={generating} disabled={generating} onPress={() => void proceedFromChoice()}>
                Next
              </DialogButton>
            </AppDialog.Actions>
          </>
        ) : null}
      </AppDialog>
      <ConfirmDialog
        visible={deleting !== null}
        title={`Delete "${deleting?.name ?? ""}"?`}
        body="Projects still referencing this credential will fall back to anonymous access until another one is selected."
        confirmLabel="Delete"
        danger
        onConfirm={() => void doDelete()}
        onCancel={() => setDeleting(null)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listContent: { padding: 12 },
  empty: { textAlign: "center", marginTop: 24 },
  card: { marginVertical: 4 },
  cardActions: { flexDirection: "row", alignItems: "center", marginRight: 4 },
})
