/**
 * Filesystem abstraction built on react-native-blob-util (supported on both platforms, Android=iOS identical API).
 * Everything works on absolute paths; all methods return Promises.
 */
import ReactNativeBlobUtil, { ReactNativeBlobUtilStat } from "react-native-blob-util"
import { Platform } from "react-native"
import Config from "react-native-config"

export const fsNative = ReactNativeBlobUtil.fs

/** Data-layout names are dotenv-driven (single source of truth, Rule 32); the literals are no-config fallbacks only */
export const DATA_DIR_BASEPATH = Config.DATA_DIR_BASEPATH || "cafebeeai"
/**
 * Interchange folder name for project metadata inside an export zip (`Include chat history`). On disk the
 * metadata lives OUTSIDE the project tree (project-meta/<uuid>/, see projectMetaDir) so a Project directory is
 * pure user files; the zip keeps this name so old and new packages stay mutually readable.
 */
export const PROJECT_CONFIG_DIR = Config.PROJECT_CONFIG_DIR || ".cafebeeai"

export function appRootPath(): string {
  const dirs = ReactNativeBlobUtil.fs.dirs
  const base = Platform.OS === "ios" ? `${dirs.LibraryDir}/Application Support` : dirs.DocumentDir
  return `${base}/${DATA_DIR_BASEPATH}`
}

export function projectsRootPath(): string {
  return joinPath(appRootPath(), "projects")
}

/** Per-project app state (config.yaml / chats / ui-state) lives beside `projects/`, never inside a Project directory */
export function projectMetaRootPath(): string {
  return joinPath(appRootPath(), "project-meta")
}

export function projectMetaDir(projectId: string): string {
  return joinPath(projectMetaRootPath(), projectId)
}

export function joinPath(...segments: string[]): string {
  return segments.filter(Boolean).join("/")
}

export async function ensureDir(path: string): Promise<void> {
  const exists = await fsNative.exists(path)
  if (!exists) {
    await fsNative.mkdir(path).catch(() => 0)
  } else {
    const st = await fsNative.stat(path)
    if (!st.type || st.type !== "directory") {
      await fsNative.unlink(path).catch(() => 0)
      await fsNative.mkdir(path).catch(() => 0)
    }
  }
}

export async function mkdir(path: string): Promise<void> {
  await fsNative.mkdir(path)
}

export async function listDir(path: string): Promise<string[]> {
  if (!(await fsNative.exists(path))) return []
  return fsNative.ls(path)
}

export async function exists(path: string): Promise<boolean> {
  return fsNative.exists(path)
}

export async function readText(path: string): Promise<string> {
  return fsNative.readFile(path, "utf8")
}

export async function writeText(path: string, data: string): Promise<void> {
  await fsNative.writeFile(path, data, "utf8")
}

/**
 * Serialized write queue per path: blob-util's mv is implemented as "delete the destination first, then renameTo",
 * so concurrent atomic writes to the same file delete each other's intermediates (tmp/destination), causing ENOENT.
 */
const writeQueues = new Map<string, Promise<void>>()

function enqueueWrite<T>(path: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(path) ?? Promise.resolve()
  const run = prev.then(task, task)
  const guard = run.then(
    () => undefined,
    () => undefined
  )
  writeQueues.set(path, guard)
  void guard.finally(() => {
    if (writeQueues.get(path) === guard) writeQueues.delete(path)
  })
  return run
}

let tmpSeq = 0

export async function atomicWriteText(path: string, data: string): Promise<void> {
  return enqueueWrite(path, async () => {
    const parent = path.slice(0, path.lastIndexOf("/"))
    if (parent) await ensureDir(parent)
    const tmp = `${path}.tmp-${Date.now()}-${tmpSeq++}`
    try {
      await fsNative.writeFile(tmp, data, "utf8")
      await fsNative.mv(tmp, path)
    } catch (err) {
      await fsNative.unlink(tmp).catch(() => 0)
      try {
        await fsNative.writeFile(path, data, "utf8")
      } catch {
        throw err
      }
    }
  })
}

export async function unlink(path: string): Promise<void> {
  if (await fsNative.exists(path)) await fsNative.unlink(path)
}

/** Recursive delete (removes a directory along with its contents) */
export async function unlinkRecursive(path: string): Promise<void> {
  if (await isDirectory(path)) {
    const entries = await listDir(path)
    for (const name of entries) {
      await unlinkRecursive(joinPath(path, name))
    }
  }
  await unlink(path)
}

export async function move(src: string, dest: string): Promise<void> {
  await fsNative.mv(src, dest)
}

export async function copy(src: string, dest: string): Promise<void> {
  await fsNative.cp(src, dest)
}

/**
 * Move a staged file into place (download_file staging -> Project target): ensures the destination's parent directory first,
 * then mv (blob-util deletes the destination before renaming, so it overwrites); if the cross-directory rename fails
 * (EXDEV-class), falls back to copy + delete-source.
 */
export async function moveInto(src: string, dest: string): Promise<void> {
  const parent = dest.slice(0, dest.lastIndexOf("/"))
  if (parent) await ensureDir(parent)
  try {
    await fsNative.mv(src, dest)
  } catch {
    await fsNative.cp(src, dest)
    await unlink(src)
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  if (!(await fsNative.exists(path))) return false
  try {
    const st = await fsNative.stat(path)
    return st.type === "directory"
  } catch {
    return false
  }
}

export async function isFile(path: string): Promise<boolean> {
  if (!(await fsNative.exists(path))) return false
  try {
    const st = await fsNative.stat(path)
    return st.type === "file"
  } catch {
    return false
  }
}

export type DirEntry = { name: string; path: string; isDirectory: boolean }

/** Recursively collect every file inside a directory (including subdirectories), returned as a list of relative paths */
export async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, relPrefix: string) {
    const entries = await listDir(dir)
    for (const name of entries) {
      const full = joinPath(dir, name)
      const rel = relPrefix ? `${relPrefix}/${name}` : name
      if (await isDirectory(full)) {
        await walk(full, rel)
      } else {
        out.push(rel)
      }
    }
  }
  await walk(root, "")
  return out
}

export async function statOf(path: string): Promise<ReactNativeBlobUtilStat | null> {
  try {
    if (!(await fsNative.exists(path))) return null
    return await fsNative.stat(path)
  } catch {
    return null
  }
}
