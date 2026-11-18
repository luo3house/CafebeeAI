/**
 * Git SDK demo (Debug page): deterministic offline fixture under CacheDir/git_demo -
 * a local bare repo plays the remote, then the full verb set runs against it:
 * ensureRepo/status -> upload -> getRemote/lsRemote -> clone -> sync(up to date) -> divergence
 * (push_rejected -> sync_conflict -> forceSync adopts remote). No network, no credentials, reproducible.
 */
import React, { useRef, useState } from "react"
import { ScrollView, StyleSheet, Text, View } from "react-native"
import { Button, useTheme } from "react-native-paper"
import ReactNativeBlobUtil from "react-native-blob-util"
import { fs } from "../../../app/app.ui.theme"
import {
  ensureRepo,
  close as closeRepo,
  initBareRepo,
  status,
  upload,
  sync,
  forceSync,
  clone,
  lsRemote,
  getRemote,
  GitOpError,
} from "react-native-pocket-git"

const ROOT = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/git_demo`
const REMOTE = `${ROOT}/origin.git`
const WORK_A = `${ROOT}/workA`
const WORK_B = `${ROOT}/workB`
const FILE_URL = `file://${REMOTE}`

interface Step {
  label: string
  ok: boolean
  detail: string
}

async function exists(p: string): Promise<boolean> {
  return ReactNativeBlobUtil.fs.exists(p)
}

async function writeFile(path: string, content: string): Promise<void> {
  await ReactNativeBlobUtil.fs.writeFile(path, content, "utf8")
}

async function readFile(path: string): Promise<string> {
  return ReactNativeBlobUtil.fs.readFile(path, "utf8")
}

export function GitDemoSection() {
  const theme = useTheme()
  const [steps, setSteps] = useState<Step[]>([])
  const [running, setRunning] = useState(false)
  const logRef = useRef<ScrollView | null>(null)

  const push = (label: string, ok: boolean, detail = "") =>
    setSteps((s) => [...s, { label, ok, detail }])

  const runDemo = async () => {
    setRunning(true)
    setSteps([])
    const handles: string[] = []
    try {
      // reset fixture
      if (await exists(ROOT)) await ReactNativeBlobUtil.fs.unlink(ROOT)
      await ReactNativeBlobUtil.fs.mkdir(ROOT)
      await initBareRepo(REMOTE)
      push("Init bare remote", true, REMOTE)

      // work A: ensure repo + first upload
      const a = await ensureRepo(WORK_A, "main")
      handles.push(a)
      const st0 = await status(a)
      push("EnsureRepo A + status (unborn)", st0.hasHead === false && st0.clean, `branch=${st0.branch}`)

      await writeFile(`${WORK_A}/notes.md`, "# demo v1\n")
      await writeFile(`${WORK_A}/local.txt`, "from A\n")
      const up1 = await upload({ handle: a, message: "demo: first upload", branch: "main", remoteUrl: FILE_URL }).promise
      push("Upload A (stage+commit+push)", up1.committed && up1.pushed, up1.commitSha?.slice(0, 8))

      const remote = await getRemote(a, "origin")
      push("getRemote == file url", remote === FILE_URL, String(remote))

      const branches = await lsRemote({ url: FILE_URL })
      push("lsRemote sees main", branches.some((b) => b.name === "main"), branches.map((b) => b.name).join(","))

      // work B clones the same remote
      await clone({ url: FILE_URL, targetPath: WORK_B, branch: "main" }).promise
      const b = await ensureRepo(WORK_B, "main")
      handles.push(b)
      const bNotes = await readFile(`${WORK_B}/notes.md`)
      push("Clone B content matches", bNotes === "# demo v1\n")

      const s1 = await sync({ handle: a, branch: "main" }).promise
      push("Sync A (already up to date)", s1.updated === false)

      // divergence: B pushes, then A commits+pushes -> push_rejected for A
      await writeFile(`${WORK_B}/extra.txt`, "from B\n")
      const upB = await upload({ handle: b, message: "demo: B commit", branch: "main" }).promise
      push("Upload B", upB.pushed)

      await writeFile(`${WORK_A}/notes.md`, "# demo v2 conflict\n")
      try {
        await upload({ handle: a, message: "demo: A diverges", branch: "main" }).promise
        push("Upload A rejected (non-fast-forward)", false, "expected push_rejected, upload succeeded?!")
      } catch (err) {
        if (err instanceof GitOpError && err.code === "push_rejected") {
          push("Upload A rejected (push_rejected)", true, err.message)
        } else {
          throw err
        }
      }

      // diverged A: plain sync must report sync_conflict (fast-forward impossible)
      try {
        await sync({ handle: a, branch: "main" }).promise
        push("Sync after divergence", false, "expected sync_conflict")
      } catch (err) {
        if (err instanceof GitOpError && err.code === "sync_conflict") {
          push("Sync reports sync_conflict", true, err.message)
        } else {
          throw err
        }
      }

      // forceSync A adopts remote wholesale (unpushed commit discarded, extra.txt arrives)
      const fs1 = await forceSync({ handle: a, branch: "main" }).promise
      push("ForceSync A adopts remote", fs1.updated === true)
      const extraExists = await exists(`${WORK_A}/extra.txt`)
      push("Remote file present after force", extraExists)
      const stA = await status(a)
      push("A clean after force", stA.clean, `branch=${stA.branch}`)

      // up-to-date upload with nothing new => nothing_to_upload
      const upIdle = await upload({ handle: a, message: "demo: idle", branch: "main" }).promise
      push("Idle upload reports nothing_to_upload", !upIdle.committed && upIdle.reason === "nothing_to_upload")
    } catch (err) {
      push("Demo failed", false, String(err))
    } finally {
      for (const h of handles) {
        try {
          await closeRepo(h)
        } catch {
          // best effort
        }
      }
      setRunning(false)
    }
  }

  return (
    <View style={styles.wrap}>
      <Text style={[styles.title, { color: theme.colors.onSurface, fontSize: fs(theme, 13) }]}>
        Git SDK offline demo (CacheDir/git_demo)
      </Text>
      <View style={styles.btnRow}>
        <Button mode="contained" compact loading={running} disabled={running} onPress={() => void runDemo()}>
          Run git fixture
        </Button>
        <Button mode="text" compact disabled={running} onPress={() => setSteps([])}>
          Clear
        </Button>
      </View>
      <ScrollView style={styles.log} ref={logRef} onContentSizeChange={() => logRef.current?.scrollToEnd()}>
        {steps.map((s, i) => (
          <View key={i} style={styles.stepRow}>
            <Text style={{ color: s.ok ? theme.colors.tertiary : theme.colors.error, fontSize: fs(theme, 12) }}>
              {s.ok ? "[ok] " : "[--] "}
              {s.label}
            </Text>
            {s.detail ? (
              <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 11) }} numberOfLines={2}>
                {s.detail}
              </Text>
            ) : null}
          </View>
        ))}
        {!steps.length ? (
          <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }}>
            {"init → upload → ls-remote → clone → sync → push_rejected → sync_conflict → forceSync"}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { padding: 12, gap: 8 },
  title: { fontWeight: "700" },
  btnRow: { flexDirection: "row", gap: 8 },
  log: { maxHeight: 260 },
  stepRow: { marginBottom: 6 },
})
