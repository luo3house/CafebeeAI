/**
 * Generic full-screen text editor: one monospace multiline TextInput fills the page; the PageHeader right side
 * carries only a save icon button. Saving triggers the caller-provided async validate (default: fully pass),
 * then awaits onSave(value, text) - validation/save errors surface as a problem-notice confirm dialog and keep
 * the editor open, success goBack()s.
 * The input is UNCONTROLLED (defaultValue + ref written by onChangeText, value read only at save): the page
 * remounts per navigation and editing a 512 KB file never re-renders per keystroke (FilePreview edit gate).
 * Keyboard avoidance via useKeyboardLift (Android API 35+ edge-to-edge; lower levels use native adjustResize).
 * readOnly mode (built-in Ask/Code, rule 35): the save icon disappears and the page renders the text as a
 * SELECTABLE monospace view instead of TextInput (an Android editable=false TextInput cannot select).
 */
import React, { useCallback, useEffect, useRef, useState } from "react"
import { ScrollView, StyleSheet, Text, TextInput as NativeTextInput } from "react-native"
import { IconButton, useTheme } from "react-native-paper"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { RootStackParamList } from "../../../app/app.ui.navigator"
import type { TextEditorValidation } from "../../../core/text-editor"
import { fs } from "../../../app/app.ui.theme"
import { showNotice } from "../../../state/notice"
import { useKeyboardLift } from "../../use-keyboard-lift"

type Props = NativeStackScreenProps<RootStackParamList, "TextEditor">

export function TextEditorScreen({ navigation, route }: Props) {
  const { label, initialText = "", validate, onSave, readOnly } = route.params
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const lift = useKeyboardLift()
  const [saving, setSaving] = useState(false)
  const textRef = useRef(initialText)

  const doSave = useCallback(async () => {
    if (!onSave) return
    setSaving(true)
    try {
      const value = textRef.current
      const verdict: TextEditorValidation = validate ? await validate(value) : { ok: true, value }
      if (!verdict.ok) {
        showNotice(verdict.message ?? "The text failed validation", { title: "Validation failed" })
        return
      }
      await onSave(verdict.value, value)
      navigation.goBack()
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Save failed" })
    } finally {
      setSaving(false)
    }
  }, [validate, onSave, navigation])

  useEffect(() => {
    navigation.setOptions({
      title: label,
      // readOnly mode (built-in Ask / Code, rule 35): display only, no save button at all
      headerRight: readOnly
        ? undefined
        : () => <IconButton icon="content-save" size={22} disabled={saving} onPress={() => void doSave()} />,
    })
  }, [navigation, label, saving, doSave, readOnly])

  if (readOnly) {
    // Read-only display = a plain selectable monospace Text (an Android editable=false TextInput never selects)
    return (
      <ScrollView style={styles.page} contentContainerStyle={styles.readContent}>
        <Text
          selectable
          style={[styles.readText, { color: theme.colors.onSurface, fontSize: fs(theme, 13), lineHeight: fs(theme, 18) }]}
        >
          {initialText}
        </Text>
      </ScrollView>
    )
  }

  return (
    <NativeTextInput
      defaultValue={initialText}
      onChangeText={(t) => {
        textRef.current = t
      }}
      multiline
      scrollEnabled
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      placeholder="Type or paste text here..."
      placeholderTextColor={theme.colors.onSurfaceVariant}
      selectionColor={theme.colors.primary}
      textAlignVertical="top"
      style={[
        styles.input,
        {
          color: theme.colors.onSurface,
          fontSize: fs(theme, 13),
          paddingBottom: (lift > 0 ? lift : insets.bottom) + 8,
        },
      ]}
    />
  )
}

const styles = StyleSheet.create({
  input: {
    flex: 1,
    fontFamily: "monospace",
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  page: { flex: 1 },
  readContent: { padding: 12, paddingBottom: 40 },
  readText: { fontFamily: "monospace" },
})
