/**
 * File preview page (PageHeader title = the file basename with its extension, taken from route params).
 * In-app preview supports Markdown/TXT (source split by block via splitMarkdownBlocks and rendered through
 * MarkdownBlock inside a FlashList so multi-MB files stay virtualized) and images (`.jpg/.jpeg/.png`,
 * contain-fitted native Image view).
 * CODE-LIKE files (the rest of the text-extension hints - js/tsx/yaml/json/.../.env/Dockerfile) are NOT
 * previewed anymore: they render the unknown-type centered layout with the editable-file icon
 * (file-edit-outline) and an inline [Edit] button next to [Open with...]. Edit opens the shared TextEditor
 * page (uncontrolled input, validate defaults to pass, save = atomicWriteText back to the same path + a
 * light "Saved" snackbar); this page re-reads the file on focus return.
 * The extension is only a LAYOUT hint here; the one content decision is the md/txt branch, which reads the
 * file anyway and refuses to render it as text when the decoded content is binary (core/file-sniff.ts),
 * degrading to the `binary` notice instead of painting mojibake. Code-like files are left alone - their
 * layout already promises nothing about the content.
 * Two separate caps, both statOf'd at page entry (the editor is a lightweight tool, opening is the gate -
 * pasting beyond the cap mid-edit is the user's own risk, nothing is re-checked at save):
 * preview cap 5 MB (md/txt/images) vs edit cap 512 KB (md/txt also gate the menu's Edit item -
 * over the cap the notice keeps only [Open with...] with "File too large to edit (over 512 KB).").
 * The header three-dot menu: md/txt get "Text wrap" (horizontal scroll <-> soft wrap) plus "Edit" when
 * within the edit cap; every file gets "Open with..." (openFileExternally), so previewing never blocks
 * external opening. Unsupported type / binary content / over cap / read failure: centered notice +
 * "Open with..." button.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Image, StyleSheet, Text, View } from "react-native"
import { ActivityIndicator, Button, Icon, IconButton, Menu, useTheme } from "react-native-paper"
import { fs } from "../../../app/app.ui.theme"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { FlashList } from "@shopify/flash-list"
import type { RootStackParamList } from "../../../app/app.ui.navigator"
import { atomicWriteText, readText, statOf } from "../../../core/fs"
import { extname, isTextExtension } from "../../../core/paths"
import { detectContentKind } from "../../../core/file-sniff"
import { openFileExternally } from "../../../core/import-export"
import { MarkdownBlock, splitMarkdownBlocks } from "../../components/markdown"
import { showNotice } from "../../../state/notice"
import { showToast } from "../../../state/toast"

type Props = NativeStackScreenProps<RootStackParamList, "FilePreview">

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024
const EDIT_MAX_BYTES = 512 * 1024
const TEXT_PREVIEW_EXTENSIONS = new Set([".md", ".markdown", ".txt"])
const IMAGE_PREVIEW_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"])

type PreviewKind = "text" | "code" | "image" | null

type Phase =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "code-edit" }
  | { kind: "too-large"; cap: "preview" | "edit" }
  | { kind: "read-error" }
  | { kind: "empty" }
  | { kind: "image" }
  /** md/txt whose DECODED content turned out to be binary: the extension was the only thing claiming text */
  | { kind: "binary" }
  | { kind: "ready"; units: string[] }

export function FilePreviewScreen({ navigation, route }: Props) {
  const { name, path } = route.params
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const ext = extname(name)
  const previewKind: PreviewKind = TEXT_PREVIEW_EXTENSIONS.has(ext) ? "text" : IMAGE_PREVIEW_EXTENSIONS.has(ext) ? "image" : isTextExtension(name) ? "code" : null
  const [phase, setPhase] = useState<Phase>(() => (previewKind ? { kind: "loading" } : { kind: "unsupported" }))
  const [sizeBytes, setSizeBytes] = useState<number | null>(null)
  const [wrap, setWrap] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: insets.top + 8 })
  const firstFocusRef = useRef(false)

  useEffect(() => {
    navigation.setOptions({
      title: name,
      headerRight: () => <IconButton icon="dots-horizontal" size={22} onPress={() => setMenuOpen(true)} />,
    })
  }, [navigation, name])

  // Rule 25: coming back from the editor must re-read the file; the first focus is the mount itself
  useEffect(() => {
    const unsub = navigation.addListener("focus", () => {
      if (!firstFocusRef.current) {
        firstFocusRef.current = true
        return
      }
      setReloadKey((k) => k + 1)
    })
    return unsub
  }, [navigation])

  useEffect(() => {
    if (!previewKind) return
    let alive = true
    ;(async () => {
      const stat = await statOf(path)
      const size = stat ? Number(stat.size) : null
      if (!alive) return
      setSizeBytes(size)
      if (previewKind === "code") {
        if (size === null) {
          setPhase({ kind: "read-error" })
          return
        }
        if (size > EDIT_MAX_BYTES) {
          setPhase({ kind: "too-large", cap: "edit" })
          return
        }
        setPhase({ kind: "code-edit" })
        return
      }
      if (size !== null && size > MAX_PREVIEW_BYTES) {
        setPhase({ kind: "too-large", cap: "preview" })
        return
      }
      if (previewKind === "image") {
        // <Image> decodes natively; errors surface through onError (e.g. corrupt file with a .png suffix)
        setPhase({ kind: "image" })
        return
      }
      try {
        const text = await readText(path)
        if (!alive) return
        // The only content decision on this page: a `.md`/`.txt` may still be binary. Refuse to paint it
        // as text and degrade to the binary notice (the code-like layout promises nothing about content).
        if (detectContentKind(text) !== "text") {
          setPhase({ kind: "binary" })
          return
        }
        const units = splitMarkdownBlocks(text)
        setPhase(units.length ? { kind: "ready", units } : { kind: "empty" })
      } catch {
        if (alive) setPhase({ kind: "read-error" })
      }
    })()
    return () => {
      alive = false
    }
  }, [previewKind, path, reloadKey])

  const doOpen = useCallback(async () => {
    setMenuOpen(false)
    try {
      await openFileExternally(name, path)
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Open failed" })
    }
  }, [name, path])

  const doEdit = useCallback(async () => {
    setMenuOpen(false)
    try {
      const content = await readText(path)
      navigation.navigate("TextEditor", {
        label: name,
        initialText: content,
        onSave: async (value) => {
          await atomicWriteText(path, String(value ?? ""))
          showToast("Saved")
        },
      })
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Read failed" })
    }
  }, [navigation, name, path])

  const canEdit = (previewKind === "code" || previewKind === "text") && sizeBytes !== null && sizeBytes <= EDIT_MAX_BYTES

  const renderItem = useCallback(
    ({ item }: { item: string }) => (
      <View style={styles.cell}>
        <MarkdownBlock content={item} selectable wrap={wrap} />
      </View>
    ),
    [wrap],
  )

  const keyExtractor = useCallback((_: string, idx: number) => String(idx), [])

  const notice = useMemo(() => {
    switch (phase.kind) {
      case "unsupported":
        return { icon: "file-question-outline", text: "Preview is not supported for this file type." }
      case "too-large":
        return phase.cap === "edit"
          ? { icon: "file-edit-outline", text: "File too large to edit (over 512 KB)." }
          : { icon: "file-document-outline", text: "File too large to preview (over 5 MB)." }
      case "binary":
        return { icon: "alert-outline", text: "This file contains binary data and cannot be previewed as text." }
      case "read-error":
        return { icon: "eye-off-outline", text: "Cannot read this file." }
      default:
        return null
    }
  }, [phase])

  return (
    <View style={styles.screen}>
      <View
        pointerEvents="none"
        style={[styles.menuAnchor, { top: insets.top + 8 }]}
        onLayout={(e) => {
          const l = e.nativeEvent.layout
          setMenuPos({ x: l.x, y: l.y })
        }}
      />
      <Menu visible={menuOpen} onDismiss={() => setMenuOpen(false)} anchor={menuPos}>
        {previewKind === "text" && phase.kind !== "binary" ? (
          <Menu.Item
            title={wrap ? "Text wrap: On" : "Text wrap: Off"}
            leadingIcon="wrap"
            onPress={() => {
              setMenuOpen(false)
              setWrap((v) => !v)
            }}
          />
        ) : null}
        {previewKind === "text" && phase.kind !== "binary" && canEdit ? (
          <Menu.Item
            title="Edit"
            leadingIcon="pencil-outline"
            onPress={() => {
              void doEdit()
            }}
          />
        ) : null}
        <Menu.Item title="Open with..." leadingIcon="open-in-new" onPress={doOpen} />
      </Menu>

      {phase.kind === "loading" ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : phase.kind === "code-edit" ? (
        <View style={styles.center}>
          <Icon source="file-edit-outline" size={40} color={theme.colors.onSurfaceVariant} />
          <Text style={[styles.noticeText, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 14) }]}>
            This file can be edited here or opened with another app.
          </Text>
          <View style={styles.noticeActions}>
            <Button mode="contained" icon="pencil-outline" onPress={() => void doEdit()}>
              Edit
            </Button>
            <Button mode="outlined" onPress={doOpen}>
              Open with...
            </Button>
          </View>
        </View>
      ) : phase.kind === "image" ? (
        <View style={[styles.imageWrap, { paddingBottom: 14 + insets.bottom }]}>
          <Image
            source={{ uri: `file://${path}` }}
            resizeMode="contain"
            style={styles.image}
            onError={() => setPhase({ kind: "read-error" })}
          />
        </View>
      ) : phase.kind === "ready" ? (
        <FlashList
          data={phase.units}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={{ paddingTop: 12, paddingBottom: 24 + insets.bottom }}
        />
      ) : phase.kind === "empty" ? (
        <View style={styles.center}>
          <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 14) }}>This file is empty.</Text>
        </View>
      ) : (
        <View style={styles.center}>
          <Icon source={notice!.icon} size={40} color={theme.colors.onSurfaceVariant} />
          <Text style={[styles.noticeText, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 14) }]}>{notice!.text}</Text>
          <Button mode="contained" onPress={doOpen}>
            Open with...
          </Button>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", gap: 14, paddingHorizontal: 24 },
  noticeText: { fontSize: 14, textAlign: "center" },
  noticeActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  cell: { paddingHorizontal: 14, paddingBottom: 2 },
  imageWrap: { flex: 1, justifyContent: "center", alignItems: "center", padding: 14 },
  image: { width: "100%", height: "100%" },
  menuAnchor: { position: "absolute", right: 16, width: 2, height: 2 },
})
