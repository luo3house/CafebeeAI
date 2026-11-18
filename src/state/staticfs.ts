/**
 * Static file server (single global Lighttpd instance enforced by the library):
 * one project directory served at a time, per-project preferences persisted in config.yaml (`static_fs`).
 * Lifecycle is explicit-only: no cold-start restore, no background stop, survives project switching;
 * starting another project's server requires the caller to confirm stealing the slot (stop first, then start).
 * The Server instance itself is module-level (not serializable); valtio only mirrors UI state.
 */
import { proxy } from "valtio"
import StaticServer, { STATES, getActiveServerId } from "@dr.pogodin/react-native-static-server"
import { projectRoot } from "../core/projects"
import { loadConfig, setPreferences, type StaticFsSpec } from "../core/config"

export type FsNetMode = "local" | "any"
export type FsStatus = "off" | "starting" | "running" | "stopping"

export const staticFs = proxy<{
  status: FsStatus
  projectId: string | null
  origin: string
  port: number
}>({
  status: "off",
  projectId: null,
  origin: "",
  port: 0,
})

/**
 * Browse project files at the browser root while the Lighttpd native modules sit behind a static build.
 * `mod_dirlisting` defaults to off in this build (mod_dirlisting.c `set_defaults`: `dir_listing = 0`), so
 * project roots without an `index.html` return 403 unless `dir-listing.activate = "enable"` is added here.
 * A Project directory holds only user files (app state lives in project-meta/), so nothing is withheld.
 */
const SERVE_EXTRA_CONFIG = ['dir-listing.activate = "enable"'].join("\n")

let server: StaticServer | null = null

function resetFsState(): void {
  staticFs.status = "off"
  staticFs.projectId = null
  staticFs.origin = ""
  staticFs.port = 0
}

export function randomFsPort(): number {
  return 49152 + Math.floor(Math.random() * (65535 - 49152 + 1))
}

export function isValidFsPort(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1024 && n <= 65535
}

export function isFsServing(projectId: string): boolean {
  return staticFs.status === "running" && staticFs.projectId === projectId
}

/** Per-project preferences; a missing persisted port becomes a fresh random one (the screen pre-fills it). */
export async function loadFsPrefs(projectId: string): Promise<{ port: number; netMode: FsNetMode }> {
  const cfg = await loadConfig(projectId)
  const fsSpec = cfg.spec.static_fs
  return {
    port: isValidFsPort(fsSpec?.port) ? fsSpec.port! : randomFsPort(),
    netMode: fsSpec?.net_mode === "any" ? "any" : "local",
  }
}

export function saveFsPrefs(projectId: string, port: number, netMode: FsNetMode): void {
  if (!isValidFsPort(port)) return
  const spec: StaticFsSpec = { port, net_mode: netMode }
  setPreferences(projectId, { static_fs: spec })
}

export async function startFs(projectId: string, port: number, netMode: FsNetMode): Promise<void> {
  if (!isValidFsPort(port)) throw new Error("Invalid port: expected an integer between 1024 and 65535")
  if (server) throw new Error("Another file server is still running")
  // A previous JS context (Metro reload / fast-refresh remount) can leave the native Lighttpd active across the
  // restart while this module lost its handle. Reclaim the single native slot first (library reattach procedure).
  try {
    const orphanId = await getActiveServerId()
    if (orphanId !== null && orphanId !== undefined) {
      const orphan = new StaticServer({ id: orphanId, state: STATES.ACTIVE, fileDir: projectRoot(projectId) })
      await orphan.stop()
    }
  } catch {
    // best-effort: if the reattach-stop fails, the real start below surfaces the actual error
  }
  staticFs.status = "starting"
  staticFs.projectId = projectId
  const inst = new StaticServer({
    fileDir: projectRoot(projectId),
    port,
    nonLocal: netMode === "any",
    stopInBackground: false,
    extraConfig: SERVE_EXTRA_CONFIG,
  })
  inst.addStateListener((state) => {
    if (state === STATES.CRASHED && server === inst) {
      void inst.stop().catch(() => {})
      server = null
      resetFsState()
    }
  })
  try {
    const origin = await inst.start()
    server = inst
    staticFs.status = "running"
    staticFs.origin = origin
    staticFs.port = inst.port
  } catch (err: any) {
    server = null
    resetFsState()
    const msg = String(err?.message ?? err ?? "")
    if (/address|port|bind|in use/i.test(msg)) {
      throw new Error(`Port ${port} is already in use. Pick another port (or tap Random) and try again.`)
    }
    throw new Error(msg || "Failed to start the file server")
  }
}

export async function stopFs(): Promise<void> {
  if (!server) {
    resetFsState()
    return
  }
  const inst = server
  staticFs.status = "stopping"
  try {
    await inst.stop()
  } finally {
    inst.removeAllStateListeners()
    server = null
    resetFsState()
  }
}

/** Deleting the served project silently releases the server as part of the (already confirmed) delete. */
export async function stopFsForProject(projectId: string): Promise<void> {
  if (staticFs.projectId === projectId && staticFs.status !== "off") {
    await stopFs()
  }
}
