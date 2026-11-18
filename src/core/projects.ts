/**
 * Project storage: uuid-directory layout + display name (stored in config.yaml), file CRUD.
 * A Project directory holds ONLY user files - app state (config/chats/ui-state) lives in
 * project-meta/<id>/ beside `projects/`, so git/upload/export need no metadata special-casing.
 */
import { joinPath, ensureDir, mkdir, listDir, unlinkRecursive, isDirectory, exists, projectMetaDir } from "./fs"
import { projectsRootPath } from "./fs"
import { uuid32, DEFAULT_PROJECT_ID, isDefaultProjectId } from "./uuid"
import { loadConfig, setPreferences, writeConfig, CONFIG_DOC_KIND } from "./config"
import { RESERVED_SEGMENTS } from "./paths"

export interface ProjectMeta {
  id: string
  displayName: string
  createdAt: number
  updatedAt?: number
}

export function projectRoot(id: string): string {
  return joinPath(projectsRootPath(), id)
}

export function isHiddenEntry(name: string): boolean {
  return name.startsWith(".")
}

export async function ensureBootstrap(): Promise<void> {
  await ensureDir(projectsRootPath())
  await ensureDefaultProject()
}

export async function ensureDefaultProject(): Promise<void> {
  const root = projectRoot(DEFAULT_PROJECT_ID)
  if (await exists(root)) return
  await ensureDir(root)
  await writeConfig(DEFAULT_PROJECT_ID, {
    kind: CONFIG_DOC_KIND,
    spec: { display_name: "Default" },
  })
}

export async function listProjects(): Promise<ProjectMeta[]> {
  await ensureBootstrap()
  const names = await listDir(projectsRootPath())
  const result: ProjectMeta[] = []
  for (const name of names) {
    if (isHiddenEntry(name)) continue
    const full = projectRoot(name)
    if (!(await isDirectory(full))) continue
    // if (!/^[0-9a-f]{32}$/.test(name)) continue
    const cfg = await loadConfig(name)
    const st = await exists(full)
    if (!st) continue
    result.push({
      id: name,
      displayName: cfg.spec.display_name || (isDefaultProjectId(name) ? "Default" : name.slice(0, 8)),
      createdAt: 0,
    })
  }
  // default project sorts first, the rest by creation time
  result.sort((a, b) => {
    if (isDefaultProjectId(a.id)) return -1
    if (isDefaultProjectId(b.id)) return 1
    return a.createdAt - b.createdAt
  })
  return result
}

export async function getProject(id: string): Promise<ProjectMeta | undefined> {
  const list = await listProjects()
  return list.find((p) => p.id === id)
}

export interface ProjectDirEntry {
  name: string
  path: string
  isDirectory: boolean
  size?: number
}

/**
 * In-project relative path -> per-segment legality normalization (prevents ../ escapes); returns null for an
 * out-of-bounds hit. Dot entries (`.env`, `.github/`, `.gitignore`, ...) are legitimate user files and pass -
 * only the `.` and `..` segments themselves are rejected, so a path can never climb above the project root.
 * The reserved `.git` is refused here too (defense in depth: the Files list already hides it).
 */
export function normalizeProjectRelPath(rel: string): string | null {
  const parts = rel.split("/").filter((p) => p.length > 0 && p !== ".")
  const out: string[] = []
  for (const p of parts) {
    if (p === "..") return null
    if (RESERVED_SEGMENTS.has(p)) return null
    out.push(p)
  }
  return out.join("/")
}

/** In-project relative path -> absolute path (locked to the Project scope) */
export function projectDir(id: string, rel = ""): string {
  const clean = normalizeProjectRelPath(rel)
  if (clean === null) return ""
  return joinPath(projectRoot(id), clean)
}

/** Project file listing (every user entry including dot entries; only the reserved `.git` stays hidden. Supports multi-level subdirectories inside the project; returns an empty list when relDir is out of bounds) */
export async function listProjectFiles(id: string, relDir = ""): Promise<ProjectDirEntry[]> {
  const dir = projectDir(id, relDir)
  if (!dir || !(await exists(dir))) return []
  const names = await listDir(dir)
  const out: ProjectDirEntry[] = []
  for (const name of names) {
    if (RESERVED_SEGMENTS.has(name)) continue
    const full = joinPath(dir, name)
    const isDir = await isDirectory(full)
    out.push({ name, path: full, isDirectory: isDir })
  }
  out.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
  return out
}

/** Create a subdirectory under the current directory (in-project relative path); throws on an invalid name or an existing entry */
export async function createProjectDir(id: string, relDir: string, name: string): Promise<string> {
  const dir = projectDir(id, relDir)
  if (!dir) throw new Error("Invalid directory path")
  if (!name || name.includes("/") || name === "." || name === "..") throw new Error("Invalid directory name")
  if (RESERVED_SEGMENTS.has(name)) throw new Error("Reserved directory name")
  const dest = joinPath(dir, name)
  if (await exists(dest)) throw new Error("A file/folder with this name already exists")
  await mkdir(dest)
  return dest
}

export async function createProject(displayName?: string): Promise<ProjectMeta> {
  await ensureBootstrap()
  const id = uuid32()
  const root = projectRoot(id)
  await ensureDir(root)
  const name = displayName?.trim() || "My Project"
  await writeConfig(id, {
    kind: CONFIG_DOC_KIND,
    spec: { display_name: name },
  })
  return { id, displayName: name, createdAt: Date.now() }
}

export async function renameProject(id: string, displayName: string): Promise<void> {
  if (isDefaultProjectId(id)) return // the default project cannot be renamed
  await writeConfig(id, {
    kind: CONFIG_DOC_KIND,
    spec: { display_name: displayName.trim() },
  })
}

/**
 * Delete a project across both trees: the user-files directory and its project-meta/<id> state
 * (config/chats/ui-state). The two unlinks are not atomic - the orphan sweeper reconciles the gap.
 */
export async function removeProject(id: string): Promise<void> {
  if (isDefaultProjectId(id)) return
  await unlinkRecursive(projectRoot(id))
  await unlinkRecursive(projectMetaDir(id))
}

/** In-project relative path -> absolute path (escape protection already applied) */
export function resolveProjectFile(id: string, relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, "").replace(/^(\.\.\/)+/, "")
  return joinPath(projectRoot(id), clean)
}

/** Entry point for changing preferences (model/provider switches land in config) */
export function setProjectPreference(id: string, part: { prefer_provider?: string; prefer_model?: string }): void {
  if (!id) return
  setPreferences(id, part)
}
