/**
 * Provider form page: name / baseURL / API Key / custom headers (key-value pairs) / model preview / connection test.
 */
import React, { useEffect, useMemo, useState } from "react"
import { ScrollView, StyleSheet, Text, View } from "react-native"
import { Button, TextInput, Divider, IconButton, ActivityIndicator, useTheme } from "react-native-paper"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { fs } from "../../../app/app.ui.theme"
import { kProviderRegistry, listModels, normalizeBaseURL, type LLMProvider } from "../../../core/providers"
import { kSecretStore } from "../../../core/secrets"
import { showToast } from "../../../state/toast"
import { showNotice } from "../../../state/notice"
import { MarkdownBlock } from "../../components/markdown"
import { useKeyboardLift } from "../../use-keyboard-lift"

export function ProviderFormScreen({ navigation, route }: { navigation: any; route: { params?: { providerId?: string } } }) {
  const providerId = route.params?.providerId
  const isEdit = Boolean(providerId)
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const keyboardLift = useKeyboardLift()

  const [name, setName] = useState("")
  const [baseURL, setBaseURL] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [headers, setHeaders] = useState<{ key: string; value: string }[]>([{ key: "", value: "" }])
  const [models, setModels] = useState<string[]>([])
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)

  const modelTable = useMemo(() => {
    if (!models.length) return ""
    const esc = (s: string) => s.replace(/\|/g, "\\|")
    const rows = [...models].sort((a, b) => a.localeCompare(b)).map((m) => `| ${esc(m)} |`)
    return `| Models (${models.length} total) |\n| --- |\n${rows.join("\n")}`
  }, [models])

  useEffect(() => {
    if (!providerId) return
    let alive = true
    const provider = kProviderRegistry().getById(providerId)
    if (!provider) return
    setName(provider.name)
    setBaseURL(provider.baseURL)
    setModels(provider.modelNamesCache ?? [])
    // Secrets live in EncryptedStorage: hydrate the form asynchronously
    void kSecretStore()
      .loadSecret(provider.id)
      .then((secrets) => {
        if (!alive) return
        setApiKey(secrets.apiKey ?? "")
        const hs = Object.entries(secrets.headers ?? {})
        setHeaders(hs.length ? hs.map(([key, value]) => ({ key, value })) : [{ key: "", value: "" }])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [providerId])

  const doSave = async () => {
    if (!name.trim() || !baseURL.trim()) {
      showNotice("Please enter a name and Base URL", { title: "Missing required fields" })
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        baseURL: normalizeBaseURL(baseURL),
        apiKey: apiKey.trim() || undefined,
        headers: Object.fromEntries(headers.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value])),
      }
      if (isEdit) {
        await kProviderRegistry().update(providerId!, payload)
        showToast("Saved")
      } else {
        await kProviderRegistry().create(payload)
        showToast("Created")
      }
      navigation.goBack()
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Save failed" })
    } finally {
      setSaving(false)
    }
  }

  const doFetchModels = async () => {
    if (!baseURL.trim()) {
      showNotice("Enter a Base URL first", { title: "Missing Base URL" })
      return
    }
    setFetching(true)
    try {
      // One-off request using the key/headers currently in the form (never stored in the secret storage)
      const previewProvider: LLMProvider = {
        id: providerId ?? "preview",
        name: name.trim() || "Preview",
        baseURL: normalizeBaseURL(baseURL),
      } as LLMProvider
      const names = await listModels(previewProvider, {
        apiKey: apiKey.trim() || undefined,
        headers: Object.fromEntries(headers.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value])),
      })
      setModels(names)
      showToast(`Fetched ${names.length} models`)
    } catch (err: any) {
      showNotice(String(err?.message ?? err), { title: "Fetch failed" })
    } finally {
      setFetching(false)
    }
  }

  return (
    <View style={[styles.flex, { marginBottom: keyboardLift }]} pointerEvents="box-none">
      <ScrollView style={styles.screen} contentContainerStyle={{ padding: 12, paddingBottom: 12 + insets.bottom }} keyboardShouldPersistTaps="handled">
        <TextInput mode="outlined" dense label="Name" value={name} onChangeText={setName} style={{ marginBottom: 10 }} />
        <TextInput
          mode="outlined"
          dense
          label="Base URL"
          value={baseURL}
          onChangeText={setBaseURL}
          placeholder="https://api.example.com/v1"
          autoCapitalize="none"
          keyboardType="url"
          style={{ marginBottom: 10 }}
        />
        <TextInput
          mode="outlined"
          dense
          label="API Key"
          value={apiKey}
          onChangeText={setApiKey}
          secureTextEntry={!showKey}
          autoCapitalize="none"
          style={{ marginBottom: 10 }}
          right={<TextInput.Icon icon={showKey ? "eye-off" : "eye"} onPress={() => setShowKey((v) => !v)} />}
        />

        <Text style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 14) }]}>Custom headers</Text>
        {headers.map((h, idx) => (
          <View key={idx} style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
            <TextInput
              mode="outlined"
              dense
              placeholder="Header name"
              value={h.key}
              onChangeText={(v) => setHeaders((prev) => prev.map((x, i) => (i === idx ? { ...x, key: v } : x)))}
              style={{ flex: 1, marginRight: 6 }}
              autoCapitalize="none"
            />
            <TextInput
              mode="outlined"
              dense
              placeholder="Value"
              value={h.value}
              onChangeText={(v) => setHeaders((prev) => prev.map((x, i) => (i === idx ? { ...x, value: v } : x)))}
              style={{ flex: 1, marginRight: 4 }}
              autoCapitalize="none"
            />
            <IconButton icon="close" style={{ margin: 0 }} onPress={() => setHeaders((prev) => prev.filter((_, i) => i !== idx))} />
          </View>
        ))}
        <Button icon="plus" compact onPress={() => setHeaders((prev) => [...prev, { key: "", value: "" }])}>
          Add header
        </Button>

        <Divider style={{ marginVertical: 12 }} />

        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
          <Text style={{ fontWeight: "700", flex: 1, fontSize: fs(theme, 14), color: theme.colors.onSurface }}>Model preview (GET /v1/models)</Text>
          <Button compact icon="cloud-download-outline" loading={fetching} onPress={doFetchModels}>
            Fetch
          </Button>
        </View>
        {fetching ? <ActivityIndicator /> : null}
        {!fetching && modelTable ? <MarkdownBlock content={modelTable} selectable={false} color={theme.colors.onSurface} /> : null}

        <Button mode="contained" style={{ marginTop: 16 }} loading={saving} onPress={doSave}>
          Save
        </Button>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1 },
  sectionLabel: { fontWeight: "600", marginVertical: 6 },
})
