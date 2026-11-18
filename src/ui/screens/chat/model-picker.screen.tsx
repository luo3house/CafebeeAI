/**
 * Provider/model picker page: Root Stack full-screen page, header/back handled by the native header (leaving falls back to resolve(null)).
 * The model list is a flattened list over all Providers, each item prefixed with its Provider name;
 * choosing determines both provider and model (returns `${providerId}\u0001${model}`), then auto-navigates back to the chat page.
 * - Top search box: 200ms debounce auto-filters the current list (matching Provider name/model name), with a clear button.
 * - requireProvider: pick a provider first → (fetch models) → pick a model; a failed fetch shows an empty state.
 */
import React, { useEffect, useRef, useState } from "react"
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native"
import { TextInput, Chip, ActivityIndicator, Divider, useTheme } from "react-native-paper"
import { fs } from "../../../app/app.ui.theme"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useSnapshot } from "valtio"
import { modelPicker, closeModelPicker } from "../../../state/modelpicker"
import { kProviderRegistry, listModels, type LLMProvider } from "../../../core/providers"
import { showNotice } from "../../../state/notice"
import { useKeyboardLift } from "../../use-keyboard-lift"

const SEP = "\u0001"

type ListItem =
  | { kind: "group"; id: string; name: string; count: number; fetching: boolean }
  | { kind: "model"; id: string; providerId: string; providerName: string; name: string }

export function ModelPickerScreen({ navigation }: { navigation: any }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const snap = useSnapshot(modelPicker)
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [selectedProvider, setSelectedProvider] = useState<LLMProvider | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [fetching, setFetching] = useState(false)
  const [query, setQuery] = useState("")
  const [search, setSearch] = useState("")
  const settledRef = useRef(true)
  const keyboardLift = useKeyboardLift()

  const needsProvider = snap.requireProvider && !selectedProvider

  // Debounce: takes effect automatically 200ms after typing pauses (no Enter/button needed)
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim().toLowerCase()), 200)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    if (!snap.visible) return
    settledRef.current = false
    const all = kProviderRegistry().getAll()
    setProviders(all)
    setQuery("")
    setSearch("")

    if (snap.requireProvider) {
      setSelectedProvider(snap.provider ? { ...snap.provider, modelNamesCache: [...(snap.provider.modelNamesCache ?? [])] } : null)
      setModels([...(snap.modelNames ?? [])])
      setFetching(false)
      return
    }

    // Flatten mode: show all cached models immediately, then background-fetch to refresh providers without cache, one by one
    setSelectedProvider(null)
    setModels([])
    void (async () => {
      const pending = all.filter((p) => !p.modelNamesCache?.length)
      setFetching(pending.length > 0)
      if (!pending.length) return
      for (const p of pending) {
        try {
          const found = await listModels(p)
          if (found.length) {
            await kProviderRegistry().updateModelNames(p.id, found)
            setProviders(kProviderRegistry().getAll())
          }
        } catch {
          // Providers whose fetch fails keep an empty cache; the list shows an empty state
        }
      }
      setFetching(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.visible])

  // On hardware back/swipe-back etc. without a choice, fall back to resolve(null) so the send flow never hangs
  useEffect(() => {
    return () => {
      if (!settledRef.current) closeModelPicker(null)
    }
  }, [])

  const title = needsProvider ? "Select a Provider" : selectedProvider ? `Select Model · ${selectedProvider.name}` : "Select Model (all Providers)"
  useEffect(() => {
    navigation.setOptions({ title })
  }, [navigation, title])

  const settle = (value: string | null) => {
    settledRef.current = true
    closeModelPicker(value)
    navigation.goBack()
  }

  const chooseProvider = async (p: LLMProvider) => {
    setSelectedProvider(p)
    setFetching(true)
    setModels(p.modelNamesCache ?? [])
    try {
      const found = await listModels(p)
      if (found.length) {
        setModels(found)
        await kProviderRegistry().updateModelNames(p.id, found)
      }
    } catch {
      showNotice("Failed to fetch the model list", { title: "Fetch failed" })
    }
    setFetching(false)
  }

  const clearSearch = () => {
    setQuery("")
    setSearch("")
  }

  const hit = (text: string) => !search || text.toLowerCase().includes(search)
  const byName = (a: string, b: string) => a.localeCompare(b)
  const listPad = { padding: 12, paddingBottom: 12 + insets.bottom + keyboardLift }

  const filteredProviders = providers.filter((p) => hit(p.name) || p.baseURL.toLowerCase().includes(search))

  const items: ListItem[] = (() => {
    if (needsProvider) return []
    if (selectedProvider) {
      return models
        .filter((m) => typeof m === "string" && m.length && hit(m))
        .sort(byName)
        .map((m) => ({ kind: "model" as const, id: `${selectedProvider.id}${SEP}${m}`, providerId: selectedProvider.id, providerName: selectedProvider.name, name: m }))
    }
    const out: ListItem[] = []
    for (const p of providers) {
      const allNames = (p.modelNamesCache ?? []).filter((m) => typeof m === "string" && m.length)
      const pHit = !search || p.name.toLowerCase().includes(search) || p.baseURL.toLowerCase().includes(search)
      const names = allNames.filter((m) => hit(m) || pHit).sort(byName)
      if (search && names.length === 0) continue
      out.push({ kind: "group", id: `group-${p.id}`, name: p.name, count: names.length, fetching: !search && fetching && allNames.length === 0 })
      for (const m of names) {
        out.push({ kind: "model", id: `${p.id}${SEP}${m}`, providerId: p.id, providerName: p.name, name: m })
      }
    }
    return out
  })()

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.searchRow}>
        <TextInput
          mode="outlined"
          dense
          placeholder={needsProvider ? "Search Providers…" : "Search models…"}
          value={query}
          onChangeText={setQuery}
          left={<TextInput.Icon icon="magnify" />}
          right={query.length > 0 ? <TextInput.Icon icon="close-circle" onPress={clearSearch} /> : null}
        />
      </View>

      {needsProvider ? (
        <FlatList
          data={filteredProviders}
          keyExtractor={(p) => p.id}
          style={styles.list}
          contentContainerStyle={listPad}
          renderItem={({ item }) => (
            <Chip onPress={() => chooseProvider(item)} style={styles.chip} icon="cloud-outline">
              {item.name} ({item.baseURL})
            </Chip>
          )}
          ListEmptyComponent={
            <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 14) }}>{providers.length === 0 ? "No Providers yet. Add one in Settings first." : "No matching Providers"}</Text>
          }
        />
      ) : (
        <>
          {selectedProvider ? (
            <View style={{ paddingHorizontal: 12 }}>
              <Chip icon="check" onClose={() => setSelectedProvider(null)} style={{ marginBottom: 4 }}>
                {selectedProvider.name}
              </Chip>
            </View>
          ) : null}

          {fetching && items.length === 0 && !search ? (
            <ActivityIndicator style={{ marginVertical: 40 }} />
          ) : (
            <FlatList
              data={items}
              keyExtractor={(it) => it.id}
              style={styles.list}
              contentContainerStyle={listPad}
              renderItem={({ item }) => {
                if (item.kind === "group") {
                  return (
                    <View style={{ marginTop: 8 }}>
                      <View style={{ flexDirection: "row", alignItems: "center" }}>
                        <Text style={{ fontSize: fs(theme, 12), fontWeight: "700", color: theme.colors.onSurface }} numberOfLines={1}>
                          {item.name}
                        </Text>
                        <Text style={{ fontSize: fs(theme, 11), color: theme.colors.onSurfaceVariant, marginLeft: 6 }}>{item.fetching ? "Fetching…" : `${item.count} models`}</Text>
                      </View>
                      <Divider />
                    </View>
                  )
                }
                return (
                  <Chip onPress={() => settle(`${item.providerId}${SEP}${item.name}`)} style={styles.chip} icon="memory">
                    {`${item.providerName} / ${item.name}`}
                  </Chip>
                )
              }}
              ListEmptyComponent={
                <Text style={{ color: theme.colors.onSurfaceVariant, paddingVertical: 6, fontSize: fs(theme, 14) }}>
                  {search ? "No matching models" : providers.length === 0 ? "No Providers yet. Add one in Settings first." : "No model lists available"}
                </Text>
              }
            />
          )}
        </>
      )}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  searchRow: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 },
  list: { flex: 1 },
  chip: { marginVertical: 3 },
})
