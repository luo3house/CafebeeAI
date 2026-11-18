/**
 * show_form full-screen form page: sandboxed WebView (CSP + navigation/file/multi-window all blocked) + injected fixed script (submit serialization / file-picker guard / snapshot restore).
 * Close = harmless collapse after a courtesy confirmation (zero impact on the AI, the card stays pending and re-openable; forms containing file inputs do not restore fields — reopen = brand-new form);
 * Discard = after confirmation, user_rejected goes back to the AI (the model continues its turn); Submit = auto-collapse back to chat (same semantics as ModelPicker).
 * JS-less form GET `app:///submit` falls back to navigation-interception parsing.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { BackHandler, StyleSheet, View } from "react-native"
import { Appbar, Menu, Text, useTheme } from "react-native-paper"
import { DialogButton } from "../../components/dialog-button"
import { WebView } from "react-native-webview"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useSnapshot } from "valtio"
import type { MD3Theme } from "../../../app/app.ui.theme"
import {
  formflow,
  resolveFormSuccess,
  rejectForm,
  failForm,
  saveDraft,
  FORM_BRIDGE_PREFIX,
  type FormDraft,
  type FormSubmitPayload,
} from "../../../state/formflow"
import { showNotice } from "../../../state/notice"
import {
  FORM_LIMITS,
  buildInjectedScript,
  parseAppSubmitUrl,
  prepareFormDoc,
  utf8ByteLength,
} from "../../../llm/form-doc"
import { AppDialog } from "../../components/app-dialog"
import { dialogCompact } from "../../components/dialog-compact"
import { dialogLiftStyle, useKeyboardLift } from "../../use-keyboard-lift"

export function FormFullScreen({ navigation, route }: { navigation: any; route: any }) {
  const toolCallId: string = route?.params?.toolCallId ?? ""
  const theme = useTheme<MD3Theme>()
  const insets = useSafeAreaInsets()
  const lift = useKeyboardLift()
  const flowSnap = useSnapshot(formflow)
  const item = flowSnap.pending.find((p) => p.toolCallId === toolCallId)
  const rawItem = formflow.pending.find((p) => p.toolCallId === toolCallId)

  const webRef = useRef<WebView<{}>>(null)
  const closingRef = useRef(false)
  const [dialog, setDialog] = useState<null | "collapse" | "discard">(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const rawHtml = rawItem?.html ?? ""
  const hasFileInput = rawItem?.hasFileInput ?? false

  const prepared = useMemo(
    () =>
      rawHtml
        ? prepareFormDoc(rawHtml, {
            dark: theme.dark,
            background: theme.colors.background,
            onSurface: theme.colors.onSurface,
            inverseSurface: theme.colors.inverseSurface,
            inverseOnSurface: theme.colors.inverseOnSurface,
          })
        : "",
    [rawHtml, theme.dark, theme.colors.background, theme.colors.onSurface, theme.colors.inverseSurface, theme.colors.inverseOnSurface]
  )

  const draft: FormDraft | null = toolCallId ? formflow.drafts[toolCallId] ?? null : null
  const injected = useMemo(
    () =>
      rawHtml
        ? buildInjectedScript({
            hasFileInput,
            restore: hasFileInput ? null : draft,
            pickLimitBytes: FORM_LIMITS.maxPickFileBytes,
            noteBackground: theme.colors.inverseSurface,
            noteColor: theme.colors.inverseOnSurface,
            bridgePrefix: FORM_BRIDGE_PREFIX,
          })
        : "",
    [rawHtml, hasFileInput, draft, theme.colors.inverseSurface, theme.colors.inverseOnSurface]
  )

  const handleSubmit = useCallback(
    (payload: FormSubmitPayload) => {
      if (closingRef.current) return
      closingRef.current = true
      if (utf8ByteLength(JSON.stringify(payload)) > FORM_LIMITS.maxResultBytes) {
        showNotice("Submission exceeds 64KB and was rejected", { title: "Submission rejected" })
        failForm(toolCallId, "payload_too_large: The submitted form data exceeds 64KB")
      } else {
        resolveFormSuccess(toolCallId, payload)
      }
      navigation.goBack()
    },
    [toolCallId, navigation]
  )

  const onMessage = useCallback(
    (event: any) => {
      let msg: any
      try {
        msg = JSON.parse(String(event?.nativeEvent?.data ?? ""))
      } catch {
        return
      }
      if (msg?.type === "submit" && msg.payload && typeof msg.payload.fields === "object" && msg.payload.fields) {
        handleSubmit({ fields: msg.payload.fields, submitter: String(msg.payload.submitter ?? "") })
        return
      }
      if (msg?.type === "snapshot" && Array.isArray(msg.payload)) {
        if (!hasFileInput) saveDraft(toolCallId, msg.payload as FormDraft)
        if (!closingRef.current) {
          closingRef.current = true
          navigation.goBack()
        }
      }
    },
    [handleSubmit, toolCallId, hasFileInput, navigation]
  )

  /** Collapse: non-file forms first request a field snapshot (for restore on reopen); file forms just close (reopen = brand-new form) */
  const collapse = useCallback(() => {
    if (closingRef.current) return
    if (hasFileInput) {
      closingRef.current = true
      navigation.goBack()
      return
    }
    webRef.current?.injectJavaScript(`window.${FORM_BRIDGE_PREFIX}_snapshot && window.${FORM_BRIDGE_PREFIX}_snapshot(); true;`)
    setTimeout(() => {
      if (!closingRef.current) {
        closingRef.current = true
        navigation.goBack()
      }
    }, 800)
  }, [hasFileInput, navigation])

  const discard = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    rejectForm(toolCallId)
    navigation.goBack()
  }, [toolCallId, navigation])

  const onShouldStartLoadWithRequest = useCallback(
    (req: any) => {
      const url = String(req?.url ?? "")
      if (url.startsWith("app:")) {
        const parsed = parseAppSubmitUrl(url)
        if (parsed) handleSubmit(parsed)
        return false
      }
      return url.startsWith("about:") || url.startsWith("data:")
    },
    [handleSubmit]
  )

  const onLoadError = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    showNotice("Failed to load the form", { title: "Form load failed" })
    failForm(toolCallId, "render_failed: The form document failed to render")
    navigation.goBack()
  }, [toolCallId, navigation])

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (dialog) return false
      setDialog("collapse")
      return true
    })
    return () => sub.remove()
  }, [dialog])

  // When the form gets resolved elsewhere (preempted/error), this page collapses automatically
  useEffect(() => {
    if (!item && !closingRef.current) {
      closingRef.current = true
      navigation.goBack()
    }
  }, [item, navigation])

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background, paddingBottom: insets.bottom }]}>
      <Appbar.Header mode="small" style={{ elevation: 0 }}>
        <Appbar.BackAction onPress={() => setDialog("collapse")} />
        <Appbar.Content title={item?.title ?? "Form"} />
        <Menu
          visible={menuOpen}
          onDismiss={() => setMenuOpen(false)}
          anchor={<Appbar.Action icon="dots-horizontal" onPress={() => setMenuOpen(true)} />}
        >
          <Menu.Item title="Discard form" onPress={() => { setMenuOpen(false); setDialog("discard") }} />
        </Menu>
      </Appbar.Header>
      <View style={[styles.flex, { marginBottom: lift }]}>
        {prepared ? (
          <WebView<{}>
            ref={webRef}
            source={{ html: prepared }}
            originWhitelist={["*"]}
            onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
            onMessage={onMessage}
            onError={onLoadError}
            injectedJavaScript={injected}
            javaScriptEnabled
            setSupportMultipleWindows={false}
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            mixedContentMode="never"
            style={styles.flex}
          />
        ) : null}
      </View>

      <AppDialog visible={dialog === "collapse"} onDismiss={() => setDialog(null)} style={dialogLiftStyle(lift)}>
        <AppDialog.Title style={dialogCompact.title}>Form not submitted yet</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <Text style={{ color: theme.colors.onSurfaceVariant }}>
            {hasFileInput ? "Reopening after collapse will clear everything you filled in." : "You can come back and continue filling it in anytime after collapsing."}
          </Text>
        </AppDialog.Content>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => setDialog(null)}>Keep filling</DialogButton>
          <DialogButton onPress={() => { setDialog(null); collapse() }}>Collapse</DialogButton>
        </AppDialog.Actions>
      </AppDialog>

      <AppDialog visible={dialog === "discard"} onDismiss={() => setDialog(null)} style={dialogLiftStyle(lift)}>
        <AppDialog.Title style={dialogCompact.title}>Discard this form?</AppDialog.Title>
        <AppDialog.Content style={dialogCompact.content}>
          <Text style={{ color: theme.colors.onSurfaceVariant }}>Everything filled in will be lost, and the AI will be notified.</Text>
        </AppDialog.Content>
        <AppDialog.Actions style={dialogCompact.actions}>
          <DialogButton onPress={() => setDialog(null)}>Keep filling</DialogButton>
          <DialogButton textColor={theme.colors.error} onPress={() => { setDialog(null); discard() }}>Discard</DialogButton>
        </AppDialog.Actions>
      </AppDialog>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
})
