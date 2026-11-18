/**
 * File Server page: explicit start/stop of the static HTTP server for ONE project directory (single global slot).
 * All configuration (port / Random / local-AnyIP) locks while this project's server is running - stop, edit, start.
 * Starting while another project occupies the slot goes through a confirm dialog (stop the other, then start).
 * Address area appears only while running (AnyIP's address cannot be known before start); Copy uses bare Clipboard
 * (the OS shows its own confirmation), Open in browser uses Linking with a problem-notice fallback.
 */
import React, { useCallback, useEffect, useState } from "react"
import { Clipboard, Linking, ScrollView, StyleSheet, Text, View } from "react-native"
import { Button, Divider, Icon, RadioButton, TextInput, useTheme } from "react-native-paper"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useSnapshot } from "valtio"
import type { RootStackParamList } from "../../../app/app.ui.navigator"
import { fs } from "../../../app/app.ui.theme"
import { runtime } from "../../../state/runtime"
import { listProjects } from "../../../core/projects"
import { showNotice } from "../../../state/notice"
import {
  staticFs,
  loadFsPrefs,
  saveFsPrefs,
  startFs,
  stopFs,
  randomFsPort,
  isValidFsPort,
  type FsNetMode,
} from "../../../state/staticfs"
import { ConfirmDialog } from "../../components/confirm-dialog"

type Props = NativeStackScreenProps<RootStackParamList, "StaticFs">

export function StaticFsScreen({ route }: Props) {
  const projectId = route.params.projectId
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const snap = useSnapshot(staticFs)
  const runtimeSnap = useSnapshot(runtime)

  const [portText, setPortText] = useState("")
  const [netMode, setNetMode] = useState<FsNetMode>("local")
  const [stealVisible, setStealVisible] = useState(false)
  const [busy, setBusy] = useState(false)

  const runningHere = snap.status === "running" && snap.projectId === projectId
  const transitioning = (snap.status === "starting" || snap.status === "stopping") && snap.projectId === projectId
  const servingElsewhere = snap.projectId !== null && snap.projectId !== projectId && snap.status !== "off"
  const locked = runningHere || transitioning || busy

  const nameOf = useCallback(
    (id: string | null) => runtimeSnap.projects.find((p) => p.id === id)?.displayName ?? "another project",
    [runtimeSnap.projects]
  )
  const projectName = nameOf(projectId)

  useEffect(() => {
    if (!runtime.projects.length) {
      void listProjects().then((list) => {
        runtime.projects = list
      })
    }
  }, [])

  useEffect(() => {
    let alive = true
    void loadFsPrefs(projectId).then((prefs) => {
      if (!alive) return
      setPortText(String(prefs.port))
      setNetMode(prefs.netMode)
    })
    return () => {
      alive = false
    }
  }, [projectId])

  const commitPort = useCallback(
    (text: string) => {
      const port = Number(text)
      if (isValidFsPort(port)) saveFsPrefs(projectId, port, netMode)
    },
    [projectId, netMode]
  )

  const doStart = useCallback(
    async (port: number) => {
      setBusy(true)
      try {
        await startFs(projectId, port, netMode)
        saveFsPrefs(projectId, port, netMode)
      } catch (err: any) {
        showNotice(String(err?.message ?? err), { title: "File server failed to start" })
      } finally {
        setBusy(false)
      }
    },
    [projectId, netMode]
  )

  const onToggle = useCallback(
    async (v: boolean) => {
      if (!v) {
        setBusy(true)
        try {
          await stopFs()
        } finally {
          setBusy(false)
        }
        return
      }
      const port = Number(portText)
      if (!isValidFsPort(port)) {
        showNotice("Enter a valid port number (integer between 1024 and 65535).", { title: "Invalid port" })
        return
      }
      if (servingElsewhere) {
        setStealVisible(true)
        return
      }
      await doStart(port)
    },
    [portText, servingElsewhere, doStart]
  )

  const onRandom = useCallback(() => {
    const p = randomFsPort()
    setPortText(String(p))
    saveFsPrefs(projectId, p, netMode)
  }, [projectId, netMode])

  const onModeChange = useCallback(
    (v: string) => {
      const mode = v === "any" ? "any" : "local"
      setNetMode(mode)
      const port = Number(portText)
      if (isValidFsPort(port)) saveFsPrefs(projectId, port, mode)
    },
    [projectId, portText]
  )

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingBottom: 16 + insets.bottom }]}>
      <Text style={[styles.projectName, { color: theme.colors.onSurface, fontSize: fs(theme, 16) }]} numberOfLines={1}>
        {projectName}
      </Text>

      {servingElsewhere ? (
        <View style={[styles.hintCard, { backgroundColor: theme.colors.surfaceVariant }]}>
          <Icon source="wifi" size={18} color={theme.colors.tertiary} />
          <Text style={[styles.hintText, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }]}>
            {`A file server is running for project "${nameOf(snap.projectId)}". Starting this one will stop it.`}
          </Text>
        </View>
      ) : null}

      <View style={styles.switchRow}>
        <Text style={[styles.switchLabel, { color: theme.colors.onSurface, fontSize: fs(theme, 15) }]}>File server</Text>
        <Button
          compact
          mode={runningHere ? "outlined" : "contained"}
          disabled={transitioning || busy}
          loading={transitioning || busy}
          onPress={() => void onToggle(!runningHere)}
          style={styles.toggleBtn}
        >
          {snap.status === "stopping" ? "Stop" : runningHere ? "Stop" : "Start"}
        </Button>
      </View>

      <Divider />

      <Text style={[styles.sectionTitle, { color: theme.colors.onSurface, fontSize: fs(theme, 14) }]}>Port</Text>
      <View style={styles.portRow}>
        <TextInput
          mode="outlined"
          dense
          keyboardType="number-pad"
          maxLength={5}
          value={portText}
          disabled={locked}
          onChangeText={(t) => setPortText(t.replace(/[^0-9]/g, ""))}
          onEndEditing={() => commitPort(portText)}
          style={[styles.portInput, { flex: 1 }]}
          contentStyle={{ fontSize: fs(theme, 14) }}
        />
        <Button compact mode="outlined" disabled={locked} onPress={onRandom} style={styles.randomBtn}>
          Random
        </Button>
      </View>

      <Divider />

      <Text style={[styles.sectionTitle, { color: theme.colors.onSurface, fontSize: fs(theme, 14) }]}>Network</Text>
      <RadioButton.Group onValueChange={onModeChange} value={netMode}>
        <RadioButton.Item style={styles.radioRow} disabled={locked} label="Local only (127.0.0.1)" value="local" />
        <RadioButton.Item style={styles.radioRow} disabled={locked} label="Any IP (local network)" value="any" />
      </RadioButton.Group>
      {netMode === "any" ? (
        <View style={styles.warnRow}>
          <Icon source="alert-outline" size={16} color={theme.colors.error} />
          <Text style={[styles.warnText, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }]}>
            Files will be exposed to your local network.
          </Text>
        </View>
      ) : null}

      <Divider />

      <Text style={[styles.sectionTitle, { color: theme.colors.onSurface, fontSize: fs(theme, 14) }]}>Address</Text>
      {runningHere ? (
        <View>
          <View style={[styles.originBox, { backgroundColor: theme.colors.surfaceVariant }]}>
            <Text selectable style={[styles.originText, { color: theme.colors.onSurface, fontSize: fs(theme, 13) }]} numberOfLines={1}>
              {snap.origin}
            </Text>
          </View>
          <View style={styles.actionRow}>
            <Button compact mode="outlined" icon="content-copy" onPress={() => Clipboard.setString(snap.origin)}>
              Copy address
            </Button>
            <Button
              compact
              mode="outlined"
              icon="open-in-new"
              onPress={() => {
                void Linking.openURL(snap.origin).catch(() => showNotice("No app can open this address.", { title: "Open failed" }))
              }}
            >
              Open in browser
            </Button>
          </View>
        </View>
      ) : (
        <Text style={[styles.stoppedHint, { color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 13) }]}>
          Start the server to get the address
        </Text>
      )}

      <ConfirmDialog
        visible={stealVisible}
        title="Stop the other file server"
        body={`A file server is running for project "${nameOf(snap.projectId)}". Stop it and start the server for "${projectName}"?`}
        confirmLabel="Stop & start"
        onCancel={() => setStealVisible(false)}
        onConfirm={() => {
          setStealVisible(false)
          void (async () => {
            try {
              await stopFs()
            } catch (err: any) {
              showNotice(String(err?.message ?? err), { title: "Stop failed" })
              return
            }
            const port = Number(portText)
            if (isValidFsPort(port)) await doStart(port)
          })()
        }}
      />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 12 },
  projectName: { fontWeight: "700" },
  hintCard: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8 },
  hintText: { flex: 1 },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  switchLabel: { fontWeight: "600" },
  toggleBtn: { borderRadius: 20, minWidth: 96 },
  sectionTitle: { fontWeight: "700" },
  portRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  portInput: { minHeight: 0 },
  randomBtn: { borderRadius: 17 },
  radioRow: { paddingVertical: 2 },
  warnRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
  warnText: { flex: 1 },
  originBox: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  originText: { fontFamily: "monospace" },
  actionRow: { flexDirection: "row", gap: 10, marginTop: 10 },
  stoppedHint: { marginTop: 2 },
})
