/**
 * Manage Trusted Hosts (Settings > Global Git Config > Manage Trusted Hosts):
 * shows the SSH known_hosts entries recorded by trust-on-first-use (`cafebeeai/git-known_hosts`),
 * with per-line delete and a full-screen TextEditor paste flow for adding entries (rule 30).
 * Un parseable lines are kept visible ("unrecognized") so hand-added entries are never silently dropped.
 */
import React, { useCallback, useLayoutEffect, useMemo, useState } from "react"
import { FlatList, RefreshControl, StyleSheet, View } from "react-native"
import { Card, IconButton, List, Text, useTheme } from "react-native-paper"
import { useFocusEffect } from "@react-navigation/native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { fs } from "../../../app/app.ui.theme"
import { ConfirmDialog } from "../../components/confirm-dialog"
import { showNotice } from "../../../state/notice"
import { showToast } from "../../../state/toast"
import { readGitKnownHosts, writeGitKnownHosts } from "../../../core/git-options"

interface HostEntry {
  raw: string
  host: string
  keyType: string
  keyPreview: string
  valid: boolean
}

function classifyLine(line: string): HostEntry | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return null
  const tokens = trimmed.split(/\s+/)
  const i = tokens[0].startsWith("@") ? 1 : 0
  const hosts = tokens[i]
  const keyType = tokens[i + 1]
  const key = tokens[i + 2]
  if (!hosts || !keyType || !key || !/^(ssh-|ecdsa-|sk-)/.test(keyType)) {
    return { raw: trimmed, host: trimmed, keyType: "", keyPreview: "", valid: false }
  }
  return {
    raw: trimmed,
    host: hosts.split(",")[0],
    keyType,
    keyPreview: `${key.slice(0, 16)}…`,
    valid: true,
  }
}

function validateKnownHostsPaste(text: string): string | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  if (lines.length === 0) return "Add at least one \"<host> <key-type> <base64-key>\" line"
  for (const line of lines) {
    const entry = classifyLine(line)
    if (!entry?.valid) return `Unrecognized line: ${line.slice(0, 60)}${line.length > 60 ? "…" : ""}`
  }
  return null
}

export function GitTrustedHostsScreen({ navigation }: { navigation: any }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [entries, setEntries] = useState<HostEntry[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [deleting, setDeleting] = useState<HostEntry | null>(null)

  const refresh = useCallback(() => {
    void (async () => {
      const text = await readGitKnownHosts()
      const parsed = text.split(/\r?\n/).map(classifyLine).filter((e): e is HostEntry => e !== null)
      setEntries(parsed)
      setLoaded(true)
    })()
  }, [])
  useFocusEffect(refresh)

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <IconButton
          icon="plus"
          size={22}
          onPress={() => {
            navigation.navigate("TextEditor", {
              label: "Add trusted host",
              initialText: "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...\n",
              validate: async (text: string) => {
                const error = validateKnownHostsPaste(text)
                return error ? { ok: false as const, message: error } : { ok: true as const, value: text }
              },
              onSave: async (value: unknown) => {
                const addition = String(value ?? "").trim()
                try {
                  const current = await readGitKnownHosts()
                  await writeGitKnownHosts(current ? `${current.trimEnd()}\n${addition}` : addition)
                  showToast("Trusted host added")
                  refresh()
                } catch (err) {
                  showNotice(String((err as Error)?.message ?? err), { title: "Save failed" })
                  throw err
                }
              },
            })
          }}
        />
      ),
    })
  }, [navigation, refresh])

  const doDelete = async () => {
    if (!deleting) return
    try {
      const current = await readGitKnownHosts()
      const lines = current.split(/\r?\n/)
      const target = deleting.raw
      let removed = false
      const kept = lines.filter((l) => {
        if (!removed && l.trim() === target) {
          removed = true
          return false
        }
        return true
      })
      await writeGitKnownHosts(kept.join("\n"))
      showToast("Trusted host removed")
      refresh()
    } catch (err) {
      showNotice(String((err as Error)?.message ?? err), { title: "Delete failed" })
    } finally {
      setDeleting(null)
    }
  }

  const emptyCopy = useMemo(
    () => (loaded && entries.length === 0
      ? "No trusted hosts yet. Hosts are recorded automatically when you first connect over SSH."
      : null),
    [loaded, entries.length],
  )

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      <FlatList
        data={entries}
        keyExtractor={(e, i) => `${i}:${e.raw.slice(0, 24)}`}
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
        ListHeaderComponent={
          <Text style={[styles.hint, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }]}>
            Removing a host makes the next SSH connection to it re-confirm its key (trust-on-first-use).
          </Text>
        }
        ListEmptyComponent={
          emptyCopy ? <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 14) }]}>{emptyCopy}</Text> : null
        }
        renderItem={({ item }) => (
          <Card style={styles.card}>
            <Card.Title
              title={item.host}
              titleNumberOfLines={1}
              subtitle={item.valid ? `${item.keyType} · ${item.keyPreview}` : "Unrecognized line"}
              subtitleNumberOfLines={1}
              left={(props) => <List.Icon {...props} icon={item.valid ? "dns-outline" : "alert-outline"} />}
              right={() => (
                <View style={styles.cardActions}>
                  <IconButton icon="delete-outline" size={20} onPress={() => setDeleting(item)} />
                </View>
              )}
            />
          </Card>
        )}
      />
      <ConfirmDialog
        visible={deleting !== null}
        title={`Remove "${deleting?.host.slice(0, 40) ?? ""}"?`}
        body="The next SSH connection to this host will have to trust its key again."
        confirmLabel="Remove"
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
  hint: { marginBottom: 4, paddingHorizontal: 2 },
  empty: { textAlign: "center", marginTop: 24 },
  card: { marginVertical: 4 },
  cardActions: { flexDirection: "row", alignItems: "center", marginRight: 4 },
})
