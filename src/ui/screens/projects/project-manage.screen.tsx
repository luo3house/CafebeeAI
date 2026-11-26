/**
 * Project management page: CRUD (create with default name My Project, rename, delete = permanent + confirmation).
 */
import React, { useCallback, useLayoutEffect, useState } from "react"
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import { Card, IconButton, List, TextInput, useTheme } from "react-native-paper"
import Config from "react-native-config"
import { APP_NAME } from "../../../app/app.constants"
import { fs } from "../../../app/app.ui.theme"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { pick, keepLocalCopy } from "@react-native-documents/picker"
import { runtime } from "../../../state/runtime"
import { dropProjectSessions } from "../../../state/chat"
import { stopFsForProject } from "../../../state/staticfs"
import { dropProjectUiStates } from "../../../core/ui-state"
import { listProjects, createProject, renameProject, removeProject } from "../../../core/projects"
import { importProjectZip } from "../../../core/import-export"
import { DEFAULT_PROJECT_ID } from "../../../core/uuid"
import { showToast } from "../../../state/toast"
import { showNotice } from "../../../state/notice"
import { ConfirmDialog } from "../../components/confirm-dialog"
import { dialogCompact } from "../../components/dialog-compact"
import { DialogButton } from "../../components/dialog-button"
import { AppDialog } from "../../components/app-dialog"
import { dialogLiftStyle, useKeyboardLift } from "../../use-keyboard-lift"
import { useModalInputFocus } from "../../use-modal-input-focus"

export function ProjectManageScreen({ navigation }: { navigation: any }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const keyboardLift = useKeyboardLift()
  const dlgStyle = dialogLiftStyle(keyboardLift)
  const [projects, setProjects] = useState(runtime.projects)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameText, setRenameText] = useState("")
  const [deleting, setDeleting] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const createInputRef = useModalInputFocus(creating)
  const renameInputRef = useModalInputFocus(renaming !== null)

  const refresh = useCallback(async () => {
    const list = await listProjects()
    runtime.projects = list
    setProjects(list)
  }, [])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }, [refresh])

  useFocusEffect(
    useCallback(() => {
      void refresh()
    }, [refresh])
  )

  const doCreate = async () => {
    try {
      const project = await createProject(newName)
      setNewName("")
      setCreating(false)
      showToast(`Created: ${project.displayName}`)
      await refresh()
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Create failed" })
    }
  }

  const doRename = async () => {
    if (!renaming) return
    try {
      await renameProject(renaming, renameText)
      setRenaming(null)
      await refresh()
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Rename failed" })
    }
  }

  const doDelete = async () => {
    if (!deleting) return
    try {
      // Deleting implicitly cancels all running turns for this project (multi-session parallel WIP): release in-memory state first, then remove the directory
      dropProjectSessions(deleting)
      dropProjectUiStates(deleting)
      // Deleting the served project releases the file-server slot as part of this (already confirmed) delete - no second dialog
      await stopFsForProject(deleting)
      await removeProject(deleting)
      if (runtime.currentProjectId === deleting) {
        runtime.currentProjectId = DEFAULT_PROJECT_ID
        runtime.currentConversationId = null
      }
      setDeleting(null)
      showToast("Project deleted")
      await refresh()
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Delete failed" })
    }
  }

  const doImportZip = useCallback(async () => {
    try {
      const result = await pick({ allowMultiSelection: false, mode: "import", type: ["application/zip"] })
      const doc = result[0]
      if (!doc) return
      const name = doc.name ?? "project.zip"
      let localPath = doc.uri
      if (localPath.startsWith("content://")) {
        const copies = await keepLocalCopy({ destination: "cachesDirectory", files: [{ uri: doc.uri, fileName: name }] })
        const copy = copies[0]
        if (copy.status === "success" && copy.localUri) localPath = copy.localUri
      }
      const imported = await importProjectZip(localPath.replace(/^file:\/\//, ""), name)
      showToast(`Project imported: ${imported.displayName}`)
      await refresh()
      if (imported.id) {
        runtime.currentProjectId = imported.id
        runtime.currentConversationId = null
      }
    } catch (err: any) {
      if (err?.code === "DOCUMENT_PICKER_CANCELED") return
      showNotice(String(err?.message ?? err), { title: "Import failed" })
    }
  }, [refresh])

  // Create / import zip consolidated into PageHeader right-side icon buttons (aligned with the Provider management standard)
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <IconButton icon="plus" size={20} onPress={() => setCreating(true)} />
          <IconButton icon="upload" size={20} onPress={() => setImporting(true)} />
        </View>
      ),
    })
  }, [navigation, doImportZip])

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      <FlatList
        data={projects}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.listPad}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={<Text style={[styles.empty, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 14) }]}>No Projects yet</Text>}
        renderItem={({ item }) => (
          <Card style={styles.card}>
            <Card.Title
              style={styles.cardTitle}
              title={item.displayName}
              titleNumberOfLines={1}
              // subtitle={item.id === DEFAULT_PROJECT_ID ? "Default Project" : ""}
              // subtitleNumberOfLines={1}
              left={(p) => <List.Icon {...p} icon="folder-outline" />}
              right={() => (
                <View style={styles.cardActions}>
                  <IconButton icon="database" size={20} onPress={() => navigation.navigate("ProjectFiles", { projectId: item.id })} />
                  {item.id !== DEFAULT_PROJECT_ID ? (
                    <>
                      <IconButton
                        icon="pencil-outline"
                        size={20}
                        onPress={() => {
                          setRenaming(item.id)
                          setRenameText(item.displayName)
                        }}
                      />
                      <IconButton icon="delete-outline" size={20} onPress={() => setDeleting(item.id)} />
                    </>
                  ) : (
                    <View />
                    // <Text style={[styles.defaultTag, { color: theme.colors.onSurfaceVariant }]}>{"Default dont show me".slice(0, 0)}</Text>
                  )}
                </View>
              )}
            />
          </Card>
        )}
      />

      <AppDialog visible={creating} onDismiss={() => setCreating(false)} style={dlgStyle}>
        <AppDialog.Title style={dialogCompact.title}>New Project</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <TextInput ref={createInputRef} mode="outlined" dense label="Project name (optional)" value={newName} onChangeText={setNewName} placeholder="My Project" />
        </AppDialog.Content>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => setCreating(false)}>
            Cancel
          </DialogButton>
          <DialogButton mode="contained" onPress={doCreate}>
            Create
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>

      <AppDialog visible={renaming !== null} onDismiss={() => setRenaming(null)} style={dlgStyle}>
        <AppDialog.Title style={dialogCompact.title}>Rename</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <TextInput ref={renameInputRef} mode="outlined" dense label="Name" value={renameText} onChangeText={setRenameText} />
        </AppDialog.Content>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => setRenaming(null)}>
            Cancel
          </DialogButton>
          <DialogButton mode="contained" onPress={doRename}>
            Save
          </DialogButton>
        </AppDialog.Actions>
      </AppDialog>

      <ConfirmDialog
        visible={importing}
        title="Import Project"
        body={`Choose a project package (.zip) exported by ${Config.APP_NAME || APP_NAME}. It will be unpacked as a new Project (files, chats, and preferences), added to this list, and switched to.`}
        confirmLabel="Choose file"
        onCancel={() => setImporting(false)}
        onConfirm={() => {
          setImporting(false)
          void doImportZip()
        }}
      />

      <ConfirmDialog
        visible={deleting !== null}
        title="Delete Project"
        body="The Project folder will be permanently deleted (including its files and chat history). This cannot be undone. Delete it?"
        confirmLabel="Delete permanently"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={doDelete}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listPad: { padding: 12 },
  card: { marginVertical: 8 },
  cardTitle: { minHeight: 56 },
  cardActions: { flexDirection: "row", marginRight: 4 },
  defaultTag: { alignSelf: "center", fontSize: 11, marginRight: 8 },
  empty: { textAlign: "center", marginTop: 24 },
})
