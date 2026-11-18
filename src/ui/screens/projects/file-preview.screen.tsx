/**
 * File preview page (PageHeader title = the file basename with its extension, taken from route params).
 * In-app preview supports Markdown/TXT (source split by block via splitMarkdownBlocks and rendered through
 * MarkdownBlock inside a FlashList so multi-MB files stay virtualized), common code extensions - js/tsx/yaml/json/...
 * (isTextLike minus the md/txt set - rendered as a stack of CodeBlock chunks of CODE_CHUNK_LINES so long files
 * virtualize; language = file extension), and images (`.jpg/.jpeg/.png`, contain-fitted native Image view).
 * The preview size cap is 5 MB for every type (statOf before read/display).
 * The header three-dot menu is fixed: text/code previews get a "Text wrap" toggle (code blocks: horizontal
 * scroll <-> soft wrap), and every file gets "Open with..." (the real system open share path,
 * openFileExternally), so previewing never blocks external opening.
 * Unsupported type / over the preview cap / read failure: centered notice + "Open with..." button.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react"
import { Image, StyleSheet, Text, View } from "react-native"
import { ActivityIndicator, Button, Icon, IconButton, Menu, useTheme } from "react-native-paper"
import { fs } from "../../../app/app.ui.theme"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { FlashList } from "@shopify/flash-list"
import type { RootStackParamList } from "../../../app/app.ui.navigator"
import { readText, statOf } from "../../../core/fs"
import { extname, isTextLike } from "../../../core/paths"
import { openFileExternally } from "../../../core/import-export"
import { MarkdownBlock, splitMarkdownBlocks } from "../../components/markdown"
import { CodeBlock } from "../../components/code-block"
import { showNotice } from "../../../state/notice"

type Props = NativeStackScreenProps<RootStackParamList, "FilePreview">

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024
const TEXT_PREVIEW_EXTENSIONS = new Set([".md", ".markdown", ".txt"])
const IMAGE_PREVIEW_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"])
// Code files are stacked as fixed-line chunks so each FlashList cell stays viewport-sane (one giant Text would defeat
// virtualization / clip under the horizontal ScrollView's maxHeight) and Copy mirrors GitHub's per-section action.
const CODE_CHUNK_LINES = 64

function chunkCodeLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split("\n")
  const out: string[] = []
  for (let i = 0; i < lines.length; i += CODE_CHUNK_LINES) out.push(lines.slice(i, i + CODE_CHUNK_LINES).join("\n"))
  return out
}

type PreviewKind = "text" | "code" | "image" | null

type Phase =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "too-large" }
  | { kind: "read-error" }
  | { kind: "empty" }
  | { kind: "image" }
  | { kind: "ready"; units: string[] }

export function FilePreviewScreen({ navigation, route }: Props) {
  const { name, path } = route.params
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const ext = extname(name)
  const previewKind: PreviewKind = TEXT_PREVIEW_EXTENSIONS.has(ext) ? "text" : IMAGE_PREVIEW_EXTENSIONS.has(ext) ? "image" : isTextLike(name) ? "code" : null
  const codeLang = ext ? ext.slice(1) : name
  const [phase, setPhase] = useState<Phase>(() => (previewKind ? { kind: "loading" } : { kind: "unsupported" }))
  const [wrap, setWrap] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: insets.top + 8 })

  useEffect(() => {
    navigation.setOptions({
      title: name,
      headerRight: () => <IconButton icon="dots-horizontal" size={22} onPress={() => setMenuOpen(true)} />,
    })
  }, [navigation, name])

  useEffect(() => {
    if (!previewKind) return
    let alive = true
    ;(async () => {
      const stat = await statOf(path)
      if (!alive) return
      if (stat && Number(stat.size) > MAX_PREVIEW_BYTES) {
        setPhase({ kind: "too-large" })
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
        const units = previewKind === "code" ? chunkCodeLines(text) : splitMarkdownBlocks(text)
        setPhase(units.length ? { kind: "ready", units } : { kind: "empty" })
      } catch {
        if (alive) setPhase({ kind: "read-error" })
      }
    })()
    return () => {
      alive = false
    }
  }, [previewKind, path])

  const doOpen = useCallback(async () => {
    setMenuOpen(false)
    try {
      await openFileExternally(name, path)
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Open failed" })
    }
  }, [name, path])

  const renderItem = useCallback(
    ({ item }: { item: string }) => (
      <View style={styles.cell}>
        {previewKind === "code" ? (
          <CodeBlock code={item} language={codeLang} wrap={wrap} />
        ) : (
          <MarkdownBlock content={item} selectable wrap={wrap} />
        )}
      </View>
    ),
    [previewKind, codeLang, wrap],
  )

  const keyExtractor = useCallback((_: string, idx: number) => String(idx), [])

  const notice = useMemo(() => {
    switch (phase.kind) {
      case "unsupported":
        return { icon: "file-question-outline", text: "Preview is not supported for this file type." }
      case "too-large":
        return { icon: "file-document-outline", text: "File too large to preview (over 5 MB)." }
      case "read-error":
        return { icon: "eye-off-outline", text: "Cannot read this file." }
      default:
        return null
    }
  }, [phase.kind])

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
        {previewKind === "text" || previewKind === "code" ? (
          <Menu.Item
            title={wrap ? "Text wrap: On" : "Text wrap: Off"}
            leadingIcon="wrap"
            onPress={() => {
              setMenuOpen(false)
              setWrap((v) => !v)
            }}
          />
        ) : null}
        <Menu.Item title="Open with..." leadingIcon="open-in-new" onPress={doOpen} />
      </Menu>

      {phase.kind === "loading" ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.primary} />
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
  cell: { paddingHorizontal: 14, paddingBottom: 2 },
  imageWrap: { flex: 1, justifyContent: "center", alignItems: "center", padding: 14 },
  image: { width: "100%", height: "100%" },
  menuAnchor: { position: "absolute", right: 16, width: 2, height: 2 },
})
