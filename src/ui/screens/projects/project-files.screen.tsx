/**
 * Project files page: browse multi-level subdirectories inside the project (enter/go back, never leaving the Project scope).
 * Tapping a file row opens the FilePreview screen (in-app Markdown/TXT preview for supported types; unsupported or
 * oversized files get a centered notice there - "Open with..." menu/button routes to openFileExternally from that page).
 * New folder, import, and export zip are consolidated into icon buttons on the right of the page header.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { FlatList, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { Divider, Icon, IconButton, Menu, TextInput, useTheme } from "react-native-paper"
import { useFocusEffect } from "@react-navigation/native"
import { fs } from "../../../app/app.ui.theme"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { pick, keepLocalCopy } from "@react-native-documents/picker"
import { useSnapshot } from "valtio"
import { runtime } from "../../../state/runtime"
import { listProjectFiles, projectDir, createProjectDir, type ProjectDirEntry } from "../../../core/projects"
import { RESERVED_SEGMENTS } from "../../../core/paths"
import { unlinkRecursive, exists, joinPath, move } from "../../../core/fs"
import { exportProjectZip, importFilesIntoProject } from "../../../core/import-export"
import { showToast } from "../../../state/toast"
import { showNotice } from "../../../state/notice"
import { ConfirmDialog } from "../../components/confirm-dialog"
import { EmptyProjectWizard } from "./empty-project-wizard"
import { DialogButton } from "../../components/dialog-button"
import { AppPressable } from "../../components/app-pressable"
import { CheckRow } from "../../components/option-row"
import { dialogCompact } from "../../components/dialog-compact"
import { AppDialog } from "../../components/app-dialog"
import { dialogLiftStyle, useKeyboardLift } from "../../use-keyboard-lift"
import { useModalInputFocus } from "../../use-modal-input-focus"
import type { RootStackParamList } from "../../../app/app.ui.navigator"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"

type Props = NativeStackScreenProps<RootStackParamList, "ProjectFiles">

export function ProjectFilesScreen({ navigation, route }: Props) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const snap = useSnapshot(runtime)
  // The page can browse any project (entry from the Projects list passes an explicit id);
  // the chat "+" panel opens the currently active project.
  const projectId = route.params?.projectId ?? snap.currentProjectId
  const [relDir, setRelDir] = useState("")
  const [files, setFiles] = useState<ProjectDirEntry[]>([])
  const [hasGit, setHasGit] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [deleting, setDeleting] = useState<ProjectDirEntry | null>(null)
  const [renaming, setRenaming] = useState<ProjectDirEntry | null>(null)
  const [renameText, setRenameText] = useState("")
  const [mkdirDlg, setMkdirDlg] = useState(false)
  const [dirName, setDirName] = useState("")
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ files: { localPath: string; name: string }[] } | null>(null)
  const [conflictChoice, setConflictChoice] = useState<"overwrite" | "skip" | "rename">("overwrite")
  const [includeChats, setIncludeChats] = useState(true)
  const [includeGit, setIncludeGit] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportDlg, setExportDlg] = useState(false)
  const keyboardLift = useKeyboardLift()
  const dlgStyle = dialogLiftStyle(keyboardLift)
  const renameInputRef = useModalInputFocus(renaming !== null)
  const dirInputRef = useModalInputFocus(mkdirDlg)

  const dirAbs = projectId ? projectDir(projectId, relDir) : ""
  // In-flight listings must not overwrite a newer project/directory selection
  // (switching projects or walking directories quickly otherwise shows the previous listing).
  const refreshSeq = useRef(0)

  const refresh = useCallback(async () => {
    if (!projectId) return
    const seq = ++refreshSeq.current
    const list = await listProjectFiles(projectId, relDir)
    if (seq !== refreshSeq.current) return
    setFiles(list)
    // .git is a reserved segment the list never shows, so a repo can look "empty" - probe it directly
    if (!relDir) {
      const git = await exists(joinPath(dirAbs, ".git"))
      if (seq === refreshSeq.current) setHasGit(git)
    }
  }, [projectId, relDir, dirAbs])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }, [refresh])

  // Rule 25: refresh on focus return (import picker, Git clone landing, external changes)
  useFocusEffect(
    useCallback(() => {
      void refresh()
    }, [refresh]),
  )

  useEffect(() => {
    setRelDir("")
    setMenuFor(null)
    setFiles([])
    setHasGit(false)
  }, [projectId])

  const enterDir = (name: string) => setRelDir(relDir ? `${relDir}/${name}` : name)
  const upDir = () => setRelDir(relDir.includes("/") ? relDir.slice(0, relDir.lastIndexOf("/")) : "")

  const doImport = useCallback(async () => {
    try {
      const result = await pick({ allowMultiSelection: true, mode: "import" })
      const prepared: { localPath: string; name: string }[] = []
      for (const doc of result) {
        const name = doc.name ?? "file"
        let localPath = doc.uri
        if (localPath.startsWith("content://")) {
          const copies = await keepLocalCopy({ destination: "cachesDirectory", files: [{ uri: doc.uri, fileName: name }] })
          const copy = copies[0]
          if (copy.status === "success" && copy.localUri) {
            localPath = copy.localUri
          }
        }
        prepared.push({ localPath: localPath.replace(/^file:\/\//, ""), name })
      }
      if (!prepared.length) return
      // Check for conflicts (within the current directory)
      const hasConflict = (await Promise.all(prepared.map(async (f) => exists(joinPath(dirAbs, f.name))))).some(Boolean)
      if (hasConflict) {
        setConflict({ files: prepared })
        return
      }
      const res = await importFilesIntoProject(projectId, prepared, "overwrite", relDir)
      showToast(`Imported ${res.imported.length} file(s)`)
      await refresh()
    } catch (err: any) {
      if (err?.code === "DOCUMENT_PICKER_CANCELED") return
      showNotice(String(err?.message ?? err), { title: "Import failed" })
    }
  }, [projectId, relDir, dirAbs, refresh])

  const resolveConflict = async (choice: typeof conflictChoice) => {
    if (!conflict) return
    const res = await importFilesIntoProject(projectId, conflict.files, choice, relDir)
    setConflict(null)
    showToast(`Imported ${res.imported.length} file(s)${res.skipped.length ? `, skipped ${res.skipped.length}` : ""}`)
    await refresh()
  }

  const openItem = (file: ProjectDirEntry) => {
    if (file.isDirectory) {
      enterDir(file.name)
      return
    }
    navigation.navigate("FilePreview", { name: file.name, path: file.path })
  }

  const doDelete = async () => {
    if (!deleting) return
    await unlinkRecursive(deleting.path)
    setDeleting(null)
    showToast("Deleted")
    await refresh()
  }

  const doRename = async () => {
    if (!renaming) return
    const target = renameText.trim()
    if (!target) {
      showNotice("Name cannot be empty", { title: "Invalid name" })
      return
    }
    if (target.includes("/") || target === "." || target === "..") {
      showNotice("Name cannot contain / or be . or ..", { title: "Invalid name" })
      return
    }
    if (RESERVED_SEGMENTS.has(target)) {
      showNotice(`"${target}" is reserved by the app`, { title: "Invalid name" })
      return
    }
    if (target === renaming.name) {
      setRenaming(null)
      return
    }
    const parent = renaming.path.slice(0, renaming.path.lastIndexOf("/"))
    const dest = joinPath(parent, target)
    if (await exists(dest)) {
      showNotice("A file/folder with this name already exists", { title: "Invalid name" })
      return
    }
    try {
      await move(renaming.path, dest)
      setRenaming(null)
      showToast("Renamed")
      await refresh()
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Rename failed" })
    }
  }

  const doMkdir = async () => {
    const name = dirName.trim()
    if (!name) {
      showNotice("Folder name cannot be empty", { title: "Invalid folder name" })
      return
    }
    if (name.includes("/") || name === "." || name === "..") {
      showNotice("Folder name cannot contain / or be . or ..", { title: "Invalid folder name" })
      return
    }
    if (RESERVED_SEGMENTS.has(name)) {
      showNotice(`"${name}" is reserved by the app`, { title: "Invalid folder name" })
      return
    }
    try {
      await createProjectDir(projectId, relDir, name)
      setMkdirDlg(false)
      setDirName("")
      await refresh()
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Create folder failed" })
    }
  }

  const doExport = async () => {
    setExporting(true)
    setExportDlg(false)
    try {
      await exportProjectZip(projectId, includeChats, includeGit)
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Export failed" })
    } finally {
      setExporting(false)
    }
  }

  // New folder / import / export zip consolidated into PageHeader right-side icon buttons
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <IconButton icon="folder-plus-outline" size={20} onPress={() => setMkdirDlg(true)} />
          <IconButton icon="plus" size={20} onPress={doImport} />
          <IconButton icon="export-variant" size={20} onPress={() => setExportDlg(true)} />
        </View>
      ),
    })
  }, [navigation, doImport])

  const segments = relDir ? relDir.split("/") : []
  const crumbs = (
    <>
      <Text style={[styles.crumbText, { color: relDir ? theme.colors.primary : theme.colors.onSurfaceVariant, fontSize: fs(theme, 13) }]} onPress={() => relDir && setRelDir("")}>
        Project root
      </Text>
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1
        return (
          <Text
            key={`${i}-${seg}`}
            style={[styles.crumbText, { color: isLast ? theme.colors.onSurface : theme.colors.primary, fontSize: fs(theme, 13) }]}
            numberOfLines={1}
            onPress={() => !isLast && setRelDir(segments.slice(0, i + 1).join("/"))}
          >
            {` / ${seg}`}
          </Text>
        )
      })}
    </>
  )

  return (
    <View style={styles.screen}>
      {projectId ? (
        <>
          <View style={[styles.breadcrumb, { backgroundColor: theme.colors.surfaceVariant }]}>
            <IconButton icon="arrow-up" size={18} style={styles.crumbBtn} disabled={!relDir} onPress={upDir} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={styles.crumbRow}>
              {crumbs}
            </ScrollView>
            <IconButton icon="folder-home-outline" size={18} style={styles.crumbBtn} disabled={!relDir} onPress={() => setRelDir("")} />
          </View>
          <FlatList
            data={files}
            keyExtractor={(f) => f.path}
            contentContainerStyle={{ padding: 10, paddingBottom: 12 + insets.bottom }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            renderItem={({ item }) => {
              const open = () => openItem(item)
              return (
                <AppPressable onPress={open}>
                  {/* divider as the row's top border: flush with the element's top edge, pressed together with the row */}
                  <Divider />
                  <View style={styles.rowContent}>
                    <View style={styles.fileIconBox}>
                      <Icon source={item.isDirectory ? "folder-outline" : "file-document-outline"} size={18} color={theme.colors.onSurfaceVariant} />
                    </View>
                    <Text style={{ flex: 1, fontSize: fs(theme, 14), color: theme.colors.onSurface }} numberOfLines={1}>
                      {item.name}
                    </Text>
                    {/* the overflow anchored to the three-dot button (an inner responder wins over the row press) stays the only excluded area */}
                    <Menu
                      visible={menuFor === item.path}
                      onDismiss={() => setMenuFor(null)}
                      anchor={<IconButton icon="dots-horizontal" size={18} onPress={() => setMenuFor(item.path)} style={{ margin: 0 }} />}
                    >
                      <Menu.Item
                        title="Rename"
                        leadingIcon="pencil-outline"
                        onPress={() => {
                          setMenuFor(null)
                          setRenaming(item)
                          setRenameText(item.name)
                        }}
                      />
                      <Menu.Item
                        title="Delete"
                        leadingIcon="delete-outline"
                        titleStyle={{ color: theme.colors.error }}
                        onPress={() => {
                          setMenuFor(null)
                          setDeleting(item)
                        }}
                      />
                    </Menu>
                  </View>
                </AppPressable>
              )
            }}
            ListEmptyComponent={
              relDir ? (
                <Text style={{ alignSelf: "center", marginTop: 24, color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 14) }}>
                  This folder is empty. Tap + in the top right to import files
                </Text>
              ) : (
                <EmptyProjectWizard
                  hasGit={hasGit}
                  onImport={() => void doImport()}
                  onClone={() => navigation.navigate("GitClone", { projectId })}
                />
              )
            }
          />

          <AppDialog visible={renaming !== null} onDismiss={() => setRenaming(null)} style={dlgStyle}>
            <AppDialog.Title style={dialogCompact.title}>Rename</AppDialog.Title>
            <AppDialog.Content style={dialogCompact.content}>
              <TextInput ref={renameInputRef} mode="outlined" dense label="Name" value={renameText} onChangeText={setRenameText} />
            </AppDialog.Content>
            <AppDialog.Actions style={dialogCompact.actions}>
              <DialogButton onPress={() => setRenaming(null)}>Cancel</DialogButton>
              <DialogButton mode="contained" onPress={doRename}>
                Save
              </DialogButton>
            </AppDialog.Actions>
          </AppDialog>

          <AppDialog visible={mkdirDlg} onDismiss={() => setMkdirDlg(false)} style={dlgStyle}>
            <AppDialog.Title style={dialogCompact.title}>New folder</AppDialog.Title>
            <AppDialog.Content style={dialogCompact.content}>
              <TextInput ref={dirInputRef} mode="outlined" dense label="Folder name" value={dirName} onChangeText={setDirName} />
            </AppDialog.Content>
            <AppDialog.Actions style={dialogCompact.actions}>
              <DialogButton onPress={() => setMkdirDlg(false)}>Cancel</DialogButton>
              <DialogButton mode="contained" onPress={doMkdir}>
                Create
              </DialogButton>
            </AppDialog.Actions>
          </AppDialog>

          <AppDialog visible={exportDlg} onDismiss={() => setExportDlg(false)} style={dlgStyle}>
            <AppDialog.Title style={dialogCompact.title}>Export Project (zip)</AppDialog.Title>
            <AppDialog.Content style={dialogCompact.content}>
              <CheckRow
                checked={includeChats}
                title="Include chat history & preferences"
                titleStyle={{ fontSize: fs(theme, 14) }}
                onPress={() => setIncludeChats((v) => !v)}
              />
              <CheckRow
                checked={includeGit}
                title="Include git history"
                titleStyle={{ fontSize: fs(theme, 14) }}
                onPress={() => setIncludeGit((v) => !v)}
              />
            </AppDialog.Content>
            <AppDialog.Actions style={dialogCompact.actions}>
              <DialogButton onPress={() => setExportDlg(false)}>Cancel</DialogButton>
              <DialogButton mode="contained" loading={exporting} onPress={doExport}>
                Export
              </DialogButton>
            </AppDialog.Actions>
          </AppDialog>

          <AppDialog visible={conflict !== null} onDismiss={() => setConflict(null)} style={dlgStyle}>
            <AppDialog.Title style={dialogCompact.title}>Duplicate file names</AppDialog.Title>
            <AppDialog.Content style={dialogCompact.content}>
              <Text style={{ color: theme.colors.onSurface, fontSize: fs(theme, 14) }}>
                Some file names conflict with files already in this folder. How should they be handled?
              </Text>
            </AppDialog.Content>
            <AppDialog.Actions style={dialogCompact.actions}>
              {(["overwrite", "skip", "rename"] as const).map((choice) => (
                <DialogButton key={choice} mode={conflictChoice === choice ? "contained" : "text"} onPress={() => setConflictChoice(choice)} style={{ marginLeft: 2 }}>
                  {choice === "overwrite" ? "Overwrite" : choice === "skip" ? "Skip" : "Auto-rename"}
                </DialogButton>
              ))}
              <DialogButton mode="contained" onPress={() => resolveConflict(conflictChoice)}>
                OK
              </DialogButton>
            </AppDialog.Actions>
          </AppDialog>

          <ConfirmDialog
            visible={deleting !== null}
            title={deleting?.isDirectory ? "Delete folder" : "Delete file"}
            body={`Delete ${deleting?.isDirectory ? "folder" : "file"} ${deleting?.name}?${deleting?.isDirectory ? " Everything inside it will be deleted too." : ""}`}
            confirmLabel="Delete"
            danger
            onCancel={() => setDeleting(null)}
            onConfirm={doDelete}
          />
        </>
      ) : (
        <View style={styles.center}>
          <Text style={{ color: theme.colors.onSurface, fontSize: fs(theme, 14) }}>No Project selected</Text>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  breadcrumb: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  crumbRow: { flexDirection: "row", alignItems: "center" },
  crumbBtn: { margin: 0, padding: 6 },
  // Full-row AppPressable (divider top border + content share the press area; only the three-dot Menu anchor is
  // excluded as an inner responder). Content vertically centered; the vertical breathing lives INSIDE the row
  // (below the divider) so the divider reads as the element's top border - the list container stays flush (padding: 10).
  rowContent: { flexDirection: "row", alignItems: "center", paddingVertical: 12 },
  fileIconBox: { padding: 6, alignItems: "center", justifyContent: "center" },
  crumbSeg: { flexDirection: "row", alignItems: "center" },
  crumbText: { fontSize: 13 },
})
