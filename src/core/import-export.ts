/**
 * Import/export: zip packaging + sharing, file import, Project import, markdown export (final Q&A text only).
 * Binaries always go through blob-util's 'ascii' path (raw byte I/O) to avoid utf8/base64 corruption.
 */
import Share from "react-native-share"
import { Platform } from "react-native"
import { zipSync, unzipSync } from "fflate"
import ReactNativeBlobUtil from "react-native-blob-util"
import { joinPath, ensureDir, listDir, exists, isDirectory, writeText, copy, statOf, unlinkRecursive, PROJECT_CONFIG_DIR, projectMetaDir } from "./fs"
import { projectRoot, projectDir, createProject } from "./projects"
import { kChatStore, type Conversation, type ChatMessage } from "./chats"
import { sanitizeFilename, basename, mimeForFile } from "./paths"

const CACHE_DIR = ReactNativeBlobUtil.fs.dirs.CacheDir
const EXPORT_SUBDIR = "exports"

const MAX_OPEN_FILE_BYTES = 512 * 1024 * 1024
export const FILE_TOO_LARGE_MESSAGE = "File too large to open (over 512 MB)"

/** Stale-cache sweep window: long enough for a share target's async/background upload to finish reading the grant URI. */
const SWEEP_MAX_AGE = 24 * 60 * 60 * 1000
let stageSeq = 0

function cachePath(name: string): string {
  return `${CACHE_DIR}/${EXPORT_SUBDIR}/${name}`
}

async function ensureCacheDir(): Promise<void> {
  await ensureDir(`${CACHE_DIR}/${EXPORT_SUBDIR}`)
}

/**
 * Event-driven cleanup of the exports cache (export zips / shared markdown / external-open staging / download staging all land here and never self-delete).
 * Trigger + TTL instead of post-share unlink: the receiving app reads the content URI asynchronously after Share.open resolves.
 */
export async function sweepShareCache(maxAgeMs: number = SWEEP_MAX_AGE): Promise<void> {
  const root = `${CACHE_DIR}/${EXPORT_SUBDIR}`
  const names = await listDir(root)
  const now = Date.now()
  for (const name of names) {
    const full = joinPath(root, name)
    try {
      const stat = await statOf(full)
      if (stat && now - Number(stat.lastModified) > maxAgeMs) await unlinkRecursive(full)
    } catch {
      // racing cleanup entry (already gone): skip
    }
  }
}

async function shareFileFromCache(name: string, stagedPath: string, type: string): Promise<void> {
  try {
    await Share.open({ url: `file://${stagedPath}`, type, title: name, showAppsToView: true })
  } catch (err: any) {
    const msg = String(err?.message ?? err)
    if (/cancel|dismiss/i.test(msg)) return
    throw err
  }
}

/** Snapshot the sandbox file into a unique cache subdirectory (keeps the plain file name as the last URI segment). */
async function stageCopy(name: string, path: string): Promise<string> {
  const dir = joinPath(CACHE_DIR, EXPORT_SUBDIR, `open_${Date.now()}_${stageSeq++}`)
  await ensureDir(dir)
  const dest = joinPath(dir, name)
  await copy(path, dest)
  return dest
}

/**
 * Reserve a unique staging file for download_file inside the exports cache (swept first per the cache convention).
 * blob-util streams the response body straight into it; the tool moveInto()s it into the Project on success,
 * unlinks it on failure, and crash-orphans age out through sweepShareCache like every other cache file.
 */
export async function stageDownloadTmp(): Promise<string> {
  await sweepShareCache()
  await ensureCacheDir()
  return cachePath(`download_${Date.now()}_${stageSeq++}.tmp`)
}

/**
 * Open any project file with an external program. Files over 512 MB are refused outright
 * (copy cost / storage headroom guard). Android: staged cache snapshot -> blob-util open.file
 * (ACTION_VIEW via the library FileProvider; single handler opens directly, multiple show the
 * system chooser); no usable VIEW handler (ENOAPP / EUNSPECIFIED) falls back to the share sheet.
 * iOS: Share.open is the "open in another app" path (open.file there is a document preview).
 * The sandbox original is never exposed: external apps get a read-only, per-URI grant on the snapshot.
 */
export async function openFileExternally(name: string, path: string): Promise<void> {
  await sweepShareCache()
  const stat = await statOf(path)
  if (stat && Number(stat.size) > MAX_OPEN_FILE_BYTES) throw new Error(FILE_TOO_LARGE_MESSAGE)
  const staged = await stageCopy(name, path)
  const type = mimeForFile(name)
  if (Platform.OS === "android") {
    try {
      await ReactNativeBlobUtil.open.file(staged, { mime: type })
      return
    } catch {
      // no ACTION_VIEW handler on this device: fall back to the share sheet
    }
  }
  await shareFileFromCache(name, staged, type)
}

async function readBytes(path: string): Promise<number[]> {
  return ReactNativeBlobUtil.fs.readFile(path, "ascii")
}

async function collectZipRecords(
  root: string,
  metaDir: string,
  includeChats: boolean,
  includeGit: boolean,
): Promise<Record<string, Uint8Array>> {
  const records: Record<string, Uint8Array> = {}
  async function walk(dir: string, prefix: string, skipGit: boolean) {
    const names = await listDir(dir)
    for (const name of names) {
      // git internals only travel when the user opts into "Include git history" (size + credential hygiene default off-path)
      if (skipGit && name === ".git") continue
      // Conversation UI state (draft/read marker) is not user data: never enters an export package (even when chat history is included)
      if (prefix === PROJECT_CONFIG_DIR && name === "ui") continue
      const full = joinPath(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (await isDirectory(full)) {
        await walk(full, rel, skipGit)
      } else {
        const bytes = await readBytes(full)
        records[rel] = Uint8Array.from(bytes)
      }
    }
  }
  await walk(root, "", !includeGit)
  // Interchange format: project state travels under the zip's `.cafebeeai/` folder (ui/ stripped above),
  // collected from project-meta/<id> - on disk it never lives inside the Project directory.
  if (includeChats) await walk(metaDir, PROJECT_CONFIG_DIR, true)
  return records
}

export interface ZipExportResult {
  path: string
  size: number
}

/** Package a Project into the cache directory (returns a file:// path) */
export async function buildProjectZip(
  projectId: string,
  includeChats: boolean,
  includeGit: boolean,
): Promise<ZipExportResult> {
  await sweepShareCache()
  await ensureCacheDir()
  const records = await collectZipRecords(projectRoot(projectId), projectMetaDir(projectId), includeChats, includeGit)
  const zipped = zipSync(records)
  const outPath = cachePath(`project_${projectId.slice(0, 8)}_${Date.now()}.zip`)
  await ReactNativeBlobUtil.fs.writeFile(outPath, Array.from(zipped), "ascii")
  return { path: `file://${outPath}`, size: zipped.length }
}

/** Share-export the zip via the share sheet */
export async function exportProjectZip(projectId: string, includeChats: boolean, includeGit: boolean): Promise<void> {
  const { path } = await buildProjectZip(projectId, includeChats, includeGit)
  await Share.open({
    url: path,
    type: "application/zip",
    title: "Exported Project",
  })
}

/**
 * Copy files returned by the picker into the project (optional in-project subdirectory relDir).
 * Conflict semantics are negotiated by the UI layer and passed in explicitly (overwrite/skip/rename).
 */
export async function importFilesIntoProject(
  projectId: string,
  files: { localPath: string; name: string }[],
  conflict: "overwrite" | "skip" | "rename",
  relDir = ""
): Promise<{ imported: string[]; skipped: string[] }> {
  const root = relDir ? projectDir(projectId, relDir) : projectRoot(projectId)
  if (!root) throw new Error(`Invalid target directory: ${relDir}`)
  await ensureDir(root)
  const imported: string[] = []
  const skipped: string[] = []
  for (const file of files) {
    const name = sanitizeFilename(file.name)
    const target = joinPath(root, name)
    if (await exists(target)) {
      if (conflict === "skip") {
        skipped.push(name)
        continue
      }
      if (conflict === "rename") {
        const dot = name.lastIndexOf(".")
        const stem = dot >= 0 ? name.slice(0, dot) : name
        const ext = dot >= 0 ? name.slice(dot) : ""
        let n = 1
        let candidate = joinPath(root, `${stem}_${n}${ext}`)
        while (await exists(candidate)) {
          n++
          candidate = joinPath(root, `${stem}_${n}${ext}`)
        }
        await ReactNativeBlobUtil.fs.cp(file.localPath, candidate)
        imported.push(basename(candidate))
        continue
      }
    }
    await ReactNativeBlobUtil.fs.cp(file.localPath, target)
    imported.push(name)
  }
  return { imported, skipped }
}

export interface ImportProjectResult {
  id: string
  displayName: string
  created: boolean
}

/** Import a zip Project: unzip → strip one wrapper layer → copy into a new Project (`.cafebeeai/` meta separates into project-meta/<id>) */
export async function importProjectZip(zipLocalPath: string, zipFileName: string): Promise<ImportProjectResult> {
  const rawPath = zipLocalPath.replace(/^file:\/\//, "")
  const bytes = Uint8Array.from(await readBytes(rawPath))
  const entries = unzipSync(bytes)
  const keys = Object.keys(entries).sort()
  if (keys.length === 0) throw new Error("Empty zip file")

  // Strip one layer: if every entry sits under the same top-level directory, drop that prefix
  const first = keys[0]
  const wrapper = first.split("/")[0]
  const hasWrapper =
    wrapper.length > 0 && keys.every((k) => k.split("/")[0] === wrapper || k === wrapper)
  const stripPrefix = hasWrapper ? `${wrapper}/` : ""

  const displayName = sanitizeFilename(zipFileName.replace(/\.zip$/i, "")) || "My Project"
  const project = await createProject(displayName)
  const root = projectRoot(project.id)
  const metaPrefix = `${PROJECT_CONFIG_DIR}/`

  for (const key of keys) {
    if (key.endsWith("/")) continue
    const rel = stripPrefix ? key.slice(stripPrefix.length) : key
    if (!rel) continue
    // Interchange layout: `.cafebeeai/` inside the zip is app state -> lands in project-meta/<id>/
    // (ui/ never travels, not even in old packages); everything else is a project file.
    let target: string
    if (rel === PROJECT_CONFIG_DIR) continue
    if (rel.startsWith(metaPrefix)) {
      const metaRel = rel.slice(metaPrefix.length)
      if (!metaRel || metaRel === "ui" || metaRel.startsWith("ui/")) continue
      target = joinPath(projectMetaDir(project.id), metaRel)
    } else {
      target = joinPath(root, rel)
    }
    const dir = target.slice(0, target.lastIndexOf("/"))
    await ensureDir(dir)
    await ReactNativeBlobUtil.fs.writeFile(target, Array.from(entries[key]), "ascii")
  }
  return { id: project.id, displayName, created: true }
}

/** markdown: conversation-level export (final Q&A text only) */
export async function exportConversationMarkdown(projectId: string, conversation: Conversation): Promise<void> {
  const { messages } = await kChatStore().get(projectId, conversation.id)
  await shareTextFile(`${sanitizeFilename(conversation.title) || "Conversation"}-${Date.now()}`, renderConversationMarkdown(conversation, messages))
}

/** markdown: raw reasoning full-text export (share sheet) */
export async function exportReasoningMarkdown(text: string, title?: string): Promise<void> {
  const name = `${sanitizeFilename(title || "Reasoning") || "Reasoning"}-${Date.now()}`
  await shareTextFile(name, `# ${title || "Reasoning"}\n\n${text}\n`)
}

/** markdown: single Q&A export (one user message + the first assistant final text after it). Exports all Q&A pairs when userIndex is omitted. */
export async function exportConversationPairMarkdown(projectId: string, conversation: Conversation, userIndex?: number): Promise<void> {
  const { messages } = await kChatStore().get(projectId, conversation.id)
  const pairs: string[] = []
  let lastUserIndex = -1
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === "user") {
      lastUserIndex = i
      continue
    }
    if (userIndex !== undefined && lastUserIndex !== userIndex) continue
    if (msg.role === "assistant" && lastUserIndex !== -1 && i === lastUserIndex + 1) {
      const userText = messages[lastUserIndex].parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n")
      const asstText = msg.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n")
      if (userText || asstText) pairs.push(`## Question\n\n${userText}\n\n## Answer\n\n${asstText}\n`)
    }
  }
  await shareTextFile(
    `${sanitizeFilename(conversation.title) || "Conversation"}-${Date.now()}`,
    `# ${conversation.title || "Untitled conversation"}\n\n${pairs.join("\n---\n") || "(No content)"}\n`
  )
}

function renderConversationMarkdown(conversation: Conversation, messages: ChatMessage[]): string {
  const lines: string[] = []
  lines.push(`# ${conversation.title || "Untitled conversation"}`)
  lines.push(`> Exported: ${new Date().toLocaleString("en-US")}`)
  lines.push("")
  for (const msg of messages) {
    const text = msg.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n")
    const label = msg.role === "user" ? "User" : "Assistant"
    if (text) lines.push(`## ${label}\n\n${text}\n`)
  }
  return lines.join("\n")
}

async function shareTextFile(name: string, content: string): Promise<void> {
  await sweepShareCache()
  await ensureCacheDir()
  const outPath = cachePath(`${name}.md`)
  await writeText(outPath, content)
  await Share.open({
    url: `file://${outPath}`,
    type: "text/markdown",
    title: name,
  })
}