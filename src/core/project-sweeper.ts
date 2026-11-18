/**
 * Orphan project-state sweeper (independent hygiene feature): runs fire-and-forget at app startup,
 * at most once per 14 days (last-run timestamp kept at `<appRoot>/project-sweeper.json`; no record =
 * run on the first startup).
 *
 * Rules:
 * 1. `project-meta/<uuid>/` with no `projects/<uuid>/` directory -> delete the whole meta tree
 *    (covers the non-atomic cross-tree project delete).
 * 2. `project-meta/<uuid>/ui/conversation_<id>.json` with no `chats/<id>.json` -> delete the ui-state file
 *    (crash residue).
 * 3. The inverse (project without meta) is legitimate and left alone - every write path ensures the
 *    meta directory on demand. `exports/` keeps its own 24h TTL sweep and is not covered here.
 *
 * The sweep is best-effort: any failure is swallowed and retried on the next startup window.
 */
import {
  joinPath,
  appRootPath,
  projectMetaRootPath,
  projectMetaDir,
  listDir,
  exists,
  isDirectory,
  readText,
  atomicWriteText,
  unlink,
  unlinkRecursive,
} from "./fs"
import { projectRoot } from "./projects"

const SWEEP_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000

function statePath(): string {
  return joinPath(appRootPath(), "project-sweeper.json")
}

async function readLastSweep(): Promise<number | null> {
  try {
    if (!(await exists(statePath()))) return null
    const parsed = JSON.parse(await readText(statePath())) as { lastSweepAt?: unknown }
    return typeof parsed.lastSweepAt === "number" ? parsed.lastSweepAt : null
  } catch {
    return null
  }
}

export async function runProjectSweepIfDue(): Promise<void> {
  try {
    const now = Date.now()
    const last = await readLastSweep()
    if (last !== null && now - last < SWEEP_INTERVAL_MS) return
    await sweepOrphans()
    await atomicWriteText(statePath(), JSON.stringify({ lastSweepAt: now }))
  } catch {
    // best-effort hygiene; the next startup window tries again
  }
}

async function sweepOrphans(): Promise<void> {
  for (const id of await listDir(projectMetaRootPath())) {
    const metaDir = projectMetaDir(id)
    if (!(await isDirectory(metaDir))) continue
    if (!(await exists(projectRoot(id)))) {
      await unlinkRecursive(metaDir)
      continue
    }
    const uiDir = joinPath(metaDir, "ui")
    for (const name of await listDir(uiDir)) {
      if (!name.startsWith("conversation_") || !name.endsWith(".json")) continue
      const convId = name.slice("conversation_".length, -".json".length)
      if (!convId) continue
      if (!(await exists(joinPath(metaDir, "chats", `${convId}.json`)))) {
        await unlink(joinPath(uiDir, name))
      }
    }
  }
}
