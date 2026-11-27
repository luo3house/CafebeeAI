/**
 * The fixed eight tools: read_file / list_files / search_files / write_file / edit_file / download_file / show_form / run_javascript.
 * Hand-written JSON Schema (replacing the AI SDK's tool()/zodSchema()) + executors;
 * scope locked to the Project directory, the git repository internals (`.git`) are off-limits (all other hidden files/dirs are allowed;
 * app state lives outside the Project in project-meta/, so nothing else needs reserving);
 * write_file / edit_file / download_file go through user confirmation (toolflow two-layer approval: app-level auto-pass / per-card confirmation);
 * reads above 64KB are truncated; read/edit use the text whitelist;
 * download_file fetches only AFTER approval: a plain http/https GET streamed straight to cache staging by react-native-blob-util
 * (no JS memory), redirects followed under the library's own cap, 2xx required, 50MB hard limit, 300s no-data stall watchdog
 * (the watchdog bites only the request - the human wait before it stays unbounded).
 * show_form suspends until the user submits the HTML form (formflow bridge), file sources use Project-relative paths.
 * run_javascript evaluates model code as an async function body in a hidden one-shot sandboxed WebView (browser DOM env, NOT Node.js;
 * network sealed, no native dialogs) - 32757B code cap, 10s wall clock from slot acquisition, 64KB result cap; execution rides the evalflow
 * FIFO queue (max 3 mounted WebViews) + the hidden host in GlobalHosts, and its confirmation goes through toolflow like the write tools.
 * The execution context ToolExecContext carries (projectId, convId, toolCallId, signal): confirmation/form bridges register by conversation ownership,
 * so cancellations/badges never cross-talk between parallel WIP conversations; signal lets network-holding tools (download) end their native task on stop/preempt.
 * Tool names/descriptions/parameter docs and result fields returned to the model are always en-US (model-facing); UI copy such as confirmation cards was zh-CN and is now en-US everywhere.
 */
import ReactNativeBlobUtil from "react-native-blob-util"
import type { ToolCallKind } from "../core/chats"
import { joinPath, readText, listDir, writeText, exists, isDirectory, statOf, moveInto, unlink } from "../core/fs"
import { projectRoot } from "../core/projects"
import { normalizeRelativePath, isTextLike, matchGlob, RESERVED_SEGMENTS } from "../core/paths"
import { stageDownloadTmp } from "../core/import-export"
import {
  requestWriteConfirmation,
  requestDownloadConfirmation,
  requestEvalConfirmation,
  setDownloadProgress,
  clearDownloadProgress,
} from "../state/toolflow"
import { requestEval } from "../state/evalflow"
import { requestForm } from "../state/formflow"
import { EVAL_LIMITS } from "./eval-doc"
import { FORM_LIMITS, formatBytes, hasFileInputTag, utf8ByteLength } from "./form-doc"

export const MAX_READ_BYTES = 64 * 1024
const MAX_WALK_DEPTH = 4
const MAX_LIST_ENTRIES = 500
const MAX_SEARCH_FILES = 500
const MAX_SEARCH_MATCHES = 50
const MAX_SEARCH_FILE_BYTES = 256 * 1024
const MAX_SEARCH_TOTAL_CHARS = 8 * 1024 * 1024

/** download_file hard caps: streamed body size (Content-Length is only a pre-check, the stream counter is authoritative) and stall timeout (ms with zero bytes received) */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
export const DOWNLOAD_STALL_MS = 300 * 1000
const DOWNLOAD_CANCELLED_ERROR = "user_cancelled: The user has interrupted this operation."

/** Convert a relative path to an absolute path inside the project; throw on illegal/reserved paths (anti-escape) */
export function resolveToolPath(projectId: string, relPath: string): string {
  const normalized = normalizeRelativePath(relPath)
  if (!normalized || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Invalid path: ${relPath}`)
  }
  if (normalized.split("/").some((seg) => RESERVED_SEGMENTS.has(seg))) {
    throw new Error(`Path is reserved and cannot be accessed by tools: ${relPath}`)
  }
  return joinPath(projectRoot(projectId), normalized)
}

export interface ToolExecContext {
  toolCallId: string
  projectId: string
  convId: string
  /** Current turn's abort signal (stop/preempt): request-holding tools (download_file) end their native task through it */
  signal?: AbortSignal
}

export interface ToolDef {
  name: ToolCallKind
  description: string
  /** JSON Schema for OpenAI function.parameters */
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, ctx: ToolExecContext) => Promise<Record<string, unknown>>
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

interface WalkState {
  out: string[]
  truncated: boolean
}

export function buildTools(projectId: string): ToolDef[] {
  const root = projectRoot(projectId)

  /** Recursively collect relative paths (skipping the reserved `.git` segment; truncated past the cap); with includeDirs=true, directories are also emitted with a trailing `/` */
  const walkTree = async (
    dir: string,
    prefix: string,
    depth: number,
    state: WalkState,
    cap: number,
    includeDirs: boolean
  ): Promise<void> => {
    if (depth <= 0 || state.truncated) return
    let names: string[]
    try {
      names = await listDir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (RESERVED_SEGMENTS.has(name)) continue
      const full = joinPath(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      let isDir = false
      try {
        isDir = await isDirectory(full)
      } catch {
        continue
      }
      if (isDir) {
        if (includeDirs) {
          if (state.out.length >= cap) {
            state.truncated = true
            return
          }
          state.out.push(`${rel}/`)
        }
        await walkTree(full, rel, depth - 1, state, cap, includeDirs)
      } else {
        if (state.out.length >= cap) {
          state.truncated = true
          return
        }
        state.out.push(rel)
      }
    }
  }

  return [
    {
      name: "read_file",
      description:
        "Read the text content of a file inside the Project workspace. Every line is prefixed with its line number (use start_line/end_line to read a range). Files larger than 64KB are truncated. Use it to gather context before answering or to quote file content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the Project root" },
          start_line: { type: "integer", description: "1-based first line to read (inclusive). Omit to read from the beginning." },
          end_line: { type: "integer", description: "1-based last line to read (inclusive). Omit to read to the end. Values past the end of the file are clamped." },
        },
        required: ["path"],
      },
      execute: async (args) => {
        const path = asString(args.path)
        if (!path) return { ok: false, error: "Missing required argument: path" }
        const abs = resolveToolPath(projectId, path)
        if (!(await exists(abs))) return { ok: false, error: `File not found: ${path}` }
        if (await isDirectory(abs)) return { ok: false, error: `Path is a directory, not a file: ${path}` }
        if (!isTextLike(path)) return { ok: false, error: `Cannot read binary file: ${path}` }
        const text = await readText(abs)
        if (text.length === 0) return { ok: true, content: "" }
        const lines = text.split("\n")
        const startArg = asInt(args.start_line)
        const endArg = asInt(args.end_line)
        if (startArg !== undefined && startArg < 1) return { ok: false, error: `Invalid start_line: ${startArg}` }
        if (endArg !== undefined && endArg < 1) return { ok: false, error: `Invalid end_line: ${endArg}` }
        if (startArg !== undefined && endArg !== undefined && startArg > endArg) {
          return { ok: false, error: `start_line (${startArg}) is greater than end_line (${endArg})` }
        }
        let start = startArg ?? 1
        let end = endArg ?? lines.length
        if (start > lines.length) {
          return { ok: false, error: `start_line (${start}) is beyond the end of the file (${lines.length} lines)` }
        }
        end = Math.min(end, lines.length)
        const selected = lines.slice(start - 1, end).join("\n")
        let body = selected
        let truncated = false
        if (body.length > MAX_READ_BYTES) {
          body = body.slice(0, MAX_READ_BYTES)
          truncated = true
        }
        const content = body
          .split("\n")
          .map((line, i) => `${String(start + i).padStart(4, " ")}\t${line}`)
          .join("\n")
        if (truncated) {
          return {
            ok: true,
            truncated: true,
            note: `File content is larger than ${MAX_READ_BYTES} characters and has been truncated`,
            content,
          }
        }
        return { ok: true, content }
      },
    },

    {
      name: "list_files",
      description:
        "List files and subdirectories (recursively, up to 4 levels) under a directory of the Project workspace. Use it to understand the current workspace layout. Optionally filter entries with a glob pattern.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative directory path to list; omit to list the Project root" },
          pattern: {
            type: "string",
            description:
              'Optional glob filter, e.g. "*.ts" or "src/**/*.json". `*` and `?` match within one path segment; `**` crosses directories. A pattern without "/" matches file names, with "/" matches relative paths.',
          },
        },
      },
      execute: async (args) => {
        const path = asString(args.path)
        const pattern = asString(args.pattern).trim()
        const target = path ? resolveToolPath(projectId, path) : root
        if (!(await exists(target))) return { ok: false, error: `Path not found: ${path || "/"}` }
        if (!(await isDirectory(target))) return { ok: false, error: `Path is a file, not a directory: ${path || "/"}` }
        const state: WalkState = { out: [], truncated: false }
        await walkTree(target, path || "", MAX_WALK_DEPTH, state, MAX_LIST_ENTRIES, true)
        let files = state.out
        if (pattern) {
          files = files.filter((f) => matchGlob(pattern, f.replace(/\/$/, "")))
        }
        if (state.truncated) {
          return {
            ok: true,
            files,
            truncated: true,
            note: `Listing truncated at ${MAX_LIST_ENTRIES} entries`,
          }
        }
        return { ok: true, files }
      },
    },

    {
      name: "search_files",
      description:
        "Search file contents in the Project workspace with a regular expression (line-based, like grep). Returns at most 50 matches formatted as `path:line: text` with 2 context lines around each match. Escape regex special characters for literal searches. Binary/non-text files are skipped silently.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for (JavaScript RegExp syntax)" },
          path: { type: "string", description: "Relative directory to search; omit to search the whole Project" },
          include: {
            type: "string",
            description: 'Optional glob filter on file names, e.g. "*.ts" (same syntax as list_files pattern)',
          },
          case_insensitive: { type: "boolean", description: "Match case-insensitively (default false)" },
        },
        required: ["pattern"],
      },
      execute: async (args) => {
        const pattern = asString(args.pattern)
        if (!pattern) return { ok: false, error: "Missing required argument: pattern" }
        let regex: RegExp
        try {
          regex = new RegExp(pattern, args.case_insensitive === true ? "i" : "")
        } catch (err: any) {
          return { ok: false, error: `Invalid regular expression: ${err?.message ?? String(err)}` }
        }
        const path = asString(args.path)
        const include = asString(args.include).trim()
        const target = path ? resolveToolPath(projectId, path) : root
        if (!(await exists(target))) return { ok: false, error: `Path not found: ${path || "/"}` }
        if (!(await isDirectory(target))) return { ok: false, error: `Path is a file, not a directory: ${path || "/"}` }
        const state: WalkState = { out: [], truncated: false }
        await walkTree(target, path || "", MAX_WALK_DEPTH, state, MAX_SEARCH_FILES, false)
        let truncated = state.truncated
        let scannedChars = 0
        const blocks: string[] = []
        let matched = 0
        for (const rel of state.out) {
          if (truncated) break
          if (include && !matchGlob(include, rel)) continue
          if (!isTextLike(rel)) continue
          const abs = resolveToolPath(projectId, rel)
          try {
            const st = await statOf(abs)
            const size = Number(st?.size ?? 0)
            if (Number.isFinite(size) && size > MAX_SEARCH_FILE_BYTES) continue
          } catch {
            continue
          }
          let text: string
          try {
            text = await readText(abs)
          } catch {
            continue
          }
          if (text.length > MAX_SEARCH_FILE_BYTES) continue
          scannedChars += text.length
          if (scannedChars > MAX_SEARCH_TOTAL_CHARS) {
            truncated = true
            break
          }
          const lines = text.split("\n")
          for (let i = 0; i < lines.length; i++) {
            if (!regex.test(lines[i])) continue
            if (matched >= MAX_SEARCH_MATCHES) {
              truncated = true
              break
            }
            matched++
            const from = Math.max(0, i - 2)
            const to = Math.min(lines.length - 1, i + 2)
            const block: string[] = []
            for (let j = from; j <= to; j++) {
              block.push(`${rel}:${j + 1}: ${lines[j]}`)
            }
            blocks.push(block.join("\n"))
          }
        }
        const matches = blocks.length > 0 ? blocks.join("\n\n") : "No matches"
        if (truncated) {
          return {
            ok: true,
            matches,
            truncated: true,
            note: `Search truncated: at most ${MAX_SEARCH_MATCHES} matches, ${MAX_SEARCH_FILES} files, 256KB per file`,
          }
        }
        return { ok: true, matches }
      },
    },

    {
      name: "write_file",
      description:
        "Create or overwrite a text file inside the Project workspace. Prefer edit_file for partial edits of existing files. The user is asked to confirm before the write is applied (skipped when auto-approval is enabled).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the Project root" },
          content: { type: "string", description: "Full content to write into the file" },
        },
        required: ["path", "content"],
      },
      execute: async (args, ctx) => {
        const path = asString(args.path)
        const content = asString(args.content)
        if (!path) return { ok: false, error: "Missing required argument: path" }
        const abs = resolveToolPath(projectId, path)
        const overwrite = await exists(abs)
        const approved = await requestWriteConfirmation({
          tool: "write_file",
          toolCallId: ctx.toolCallId,
          projectId,
          convId: ctx.convId,
          path,
          content,
          overwrite,
        })
        if (!approved) {
          return { ok: false, rejected: true, error: "The user rejected this write request" }
        }
        try {
          await writeText(abs, content)
          return { ok: true, overwritten: overwrite }
        } catch (err: any) {
          return { ok: false, error: `Write failed: ${err?.message ?? String(err)}` }
        }
      },
    },

    {
      name: "edit_file",
      description:
        "Edit an existing text file by exact string replacement (old_string -> new_string). old_string must match the file content exactly; if it appears multiple times, either provide more surrounding context to make it unique or set replace_all. Prefer this over write_file for partial edits. The user is asked to confirm before the edit is applied (skipped when auto-approval is enabled).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the Project root" },
          old_string: { type: "string", description: "Exact non-empty text to replace" },
          new_string: { type: "string", description: "Replacement text (may be empty to delete)" },
          replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match (default false)" },
        },
        required: ["path", "old_string", "new_string"],
      },
      execute: async (args, ctx) => {
        const path = asString(args.path)
        const oldString = asString(args.old_string)
        const newString = asString(args.new_string)
        if (!path) return { ok: false, error: "Missing required argument: path" }
        if (!oldString) return { ok: false, error: "Missing required argument: old_string (must be non-empty)" }
        if (args.new_string === undefined) return { ok: false, error: "Missing required argument: new_string (pass an empty string to delete)" }
        const abs = resolveToolPath(projectId, path)
        if (!(await exists(abs))) {
          return { ok: false, error: `File not found: ${path}. Use write_file to create a new file.` }
        }
        if (await isDirectory(abs)) return { ok: false, error: `Path is a directory, not a file: ${path}` }
        if (!isTextLike(path)) return { ok: false, error: `Cannot edit binary file: ${path}` }
        const text = await readText(abs)
        const count = countOccurrences(text, oldString)
        if (count === 0) return { ok: false, error: `No match found for old_string in: ${path}` }
        const replaceAll = args.replace_all === true
        if (count > 1 && !replaceAll) {
          return {
            ok: false,
            error: `Multiple matches (${count}) found for old_string in: ${path}. Provide more surrounding context to make it unique, or set replace_all.`,
          }
        }
        const approved = await requestWriteConfirmation({
          tool: "edit_file",
          toolCallId: ctx.toolCallId,
          projectId,
          convId: ctx.convId,
          path,
          content: newString,
          oldContent: oldString,
          overwrite: true,
        })
        if (!approved) {
          return { ok: false, rejected: true, error: "The user rejected this write request" }
        }
        let next: string
        if (replaceAll) {
          next = text.split(oldString).join(newString)
        } else {
          const idx = text.indexOf(oldString)
          next = text.slice(0, idx) + newString + text.slice(idx + oldString.length)
        }
        try {
          await writeText(abs, next)
          return { ok: true, overwritten: true, replacements: replaceAll ? count : 1 }
        } catch (err: any) {
          return { ok: false, error: `Write failed: ${err?.message ?? String(err)}` }
        }
      },
    },

    {
      name: "download_file",
      description:
        "Download a file from an HTTP(S) URL into the Project workspace (e.g. a CDN CSS/JS library needed by a generated web page). The request is a plain GET and is sent ONLY after the user approves this tool call (skipped when auto-approval is enabled); an existing file at the path is overwritten after approval. Limits: 2xx response required, redirects followed under the library cap, at most 50MB, 300s no-data timeout.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTP or HTTPS URL of the file to download" },
          path: { type: "string", description: "File path relative to the Project root to store the downloaded file at" },
        },
        required: ["url", "path"],
      },
      execute: async (args, ctx) => {
        const url = asString(args.url)
        const path = asString(args.path)
        if (!url) return { ok: false, error: "Missing required argument: url" }
        if (!path) return { ok: false, error: "Missing required argument: path" }
        if (!/^https?:\/\//i.test(url)) return { ok: false, error: `Invalid URL (only http/https URLs are supported): ${url}` }
        let abs: string
        try {
          abs = resolveToolPath(projectId, path)
        } catch (err: any) {
          return { ok: false, error: String(err?.message ?? err) }
        }
        if (await isDirectory(abs)) return { ok: false, error: `Path is a directory, not a file: ${path}` }
        const overwrite = await exists(abs)
        const approved = await requestDownloadConfirmation({
          tool: "download_file",
          toolCallId: ctx.toolCallId,
          projectId,
          convId: ctx.convId,
          path,
          url,
          overwrite,
        })
        if (!approved) return { ok: false, rejected: true, error: "The user rejected this download request" }
        if (ctx.signal?.aborted) return { ok: false, error: DOWNLOAD_CANCELLED_ERROR }

        // The fetch starts only after human approval. The body streams straight into the staging file (native, type 'path' -
        // no bytes pass through JS), blob-util's `timeout` bounds connect/write only (it deliberately leaves file downloads
        // with NO read timeout), so the stall window lives here: any progress tick re-arms it, 300s without bytes cancels
        // the native task. The stream counter is the authoritative size gate (Content-Length can be absent or lie).
        const tmpPath = await stageDownloadTmp()
        let failure: string | null = null
        let aborted = false
        let stalled = false
        let settled = false
        let stallTimer: ReturnType<typeof setTimeout> | null = null
        const task = ReactNativeBlobUtil.config({ path: tmpPath, overwrite: true, followRedirect: true }).fetch("GET", url)
        const armStall = () => {
          if (stallTimer) clearTimeout(stallTimer)
          stallTimer = setTimeout(() => {
            stalled = true
            void task.cancel()
          }, DOWNLOAD_STALL_MS)
        }
        const onAbort = () => {
          aborted = true
          void task.cancel()
        }
        const exceedCap = () => {
          failure = `Download failed: the file exceeds the ${formatBytes(MAX_DOWNLOAD_BYTES)} limit`
          void task.cancel()
        }
        ctx.signal?.addEventListener("abort", onAbort, { once: true })
        armStall()
        task.progress((received, total) => {
          if (settled) return
          armStall()
          setDownloadProgress(ctx.toolCallId, received, Number.isFinite(total) && total > 0 ? total : 0)
          if (received > MAX_DOWNLOAD_BYTES) exceedCap()
        })
        task.stateChange((info) => {
          const declared = Number(info.headers?.["content-length"] ?? info.headers?.["Content-Length"] ?? "")
          if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) exceedCap()
        })
        try {
          const res = await task
          if (aborted) return { ok: false, error: DOWNLOAD_CANCELLED_ERROR }
          if (stalled) return { ok: false, error: `Download failed: timed out (no data received for ${DOWNLOAD_STALL_MS / 1000} seconds)` }
          if (failure) return { ok: false, error: failure }
          if (!res.ok) return { ok: false, error: `Download failed: HTTP ${res.status}` }
          const written = res.path() ?? tmpPath
          const st = await statOf(written)
          const bytes = Number(st?.size ?? 0)
          if (bytes > MAX_DOWNLOAD_BYTES) return { ok: false, error: `Download failed: the file exceeds the ${formatBytes(MAX_DOWNLOAD_BYTES)} limit` }
          await moveInto(written, abs)
          return { ok: true, bytes, overwritten: overwrite }
        } catch (err: any) {
          if (aborted) return { ok: false, error: DOWNLOAD_CANCELLED_ERROR }
          if (stalled) return { ok: false, error: `Download failed: timed out (no data received for ${DOWNLOAD_STALL_MS / 1000} seconds)` }
          if (failure) return { ok: false, error: failure }
          return { ok: false, error: `Download failed: ${err?.message ?? String(err)}` }
        } finally {
          settled = true
          if (stallTimer) clearTimeout(stallTimer)
          ctx.signal?.removeEventListener("abort", onAbort)
          clearDownloadProgress(ctx.toolCallId)
          await unlink(tmpPath).catch(() => 0)
        }
      },
    },

    {
      name: "show_form",
      description:
        "Show an interactive HTML form to the user and wait for their submission. " +
        "Provide exactly one of: 'html' (inline HTML source, under 128KB) or 'html_path' (Project-relative .html file, at most 2MB; write larger documents into the Project with write_file first, then reference the path). " +
        "Form conventions: give every control a unique 'name'; wrap controls in a <form action=\"app:///submit\"> with a native submit button (do NOT call form.submit()/requestSubmit() programmatically: only a real user tap on a submit button is accepted). " +
        "Do NOT reference external or CDN resources (scripts, styles, images): network access is blocked and all code/markup must be inline in the document. " +
        "<input type=\"file\"> is supported so the user can pick local documents (including binary): read and process them with in-page JavaScript (FileReader etc.), write the derived results into named form fields, and submit only those results. Raw file content is never sent to you; file inputs arrive as metadata only ({name,size,type}). " +
        "The user may reject the form or move on without submitting; handle the error result gracefully.",
      parameters: {
        type: "object",
        properties: {
          html: {
            type: "string",
            description: "Inline HTML source (under 128KB). Provide either html or html_path, not both.",
          },
          html_path: {
            type: "string",
            description: "Project-relative path to an .html file (at most 2MB). Provide either html or html_path, not both.",
          },
          title: {
            type: "string",
            description: "Short label shown in the form screen header and on the chat card (optional).",
          },
        },
      },
      execute: async (args, ctx) => {
        const inline = asString(args.html)
        const relPath = asString(args.html_path)
        const hasInline = inline.length > 0
        const hasPath = relPath.length > 0
        if (hasInline === hasPath) {
          return { ok: false, error: "Provide exactly one of: html, html_path" }
        }
        let html = ""
        let sizeBytes = 0
        if (hasInline) {
          sizeBytes = utf8ByteLength(inline)
          if (sizeBytes > FORM_LIMITS.maxInlineHtmlBytes) {
            return {
              ok: false,
              error: `html_too_large: Inline html exceeds ${formatBytes(FORM_LIMITS.maxInlineHtmlBytes)}; write it into the Project with write_file and pass html_path instead`,
            }
          }
          html = inline
        } else {
          const abs = resolveToolPath(projectId, relPath)
          if (!(await exists(abs))) return { ok: false, error: `File not found: ${relPath}` }
          if (await isDirectory(abs)) return { ok: false, error: `Path is a directory, not a file: ${relPath}` }
          if (!isTextLike(relPath)) return { ok: false, error: `Not an HTML file: ${relPath}` }
          html = await readText(abs)
          sizeBytes = utf8ByteLength(html)
          if (sizeBytes > FORM_LIMITS.maxHtmlFileBytes) {
            return {
              ok: false,
              error: `html_too_large: ${relPath} exceeds ${formatBytes(FORM_LIMITS.maxHtmlFileBytes)}`,
            }
          }
        }
        return requestForm({
          toolCallId: ctx.toolCallId,
          projectId,
          convId: ctx.convId,
          title: asString(args.title).trim() || "Form",
          html,
          hasFileInput: hasFileInputTag(html),
          sizeBytes,
        })
      },
    },

    {
      name: "run_javascript",
      description:
        "Evaluate JavaScript code in a sandboxed browser DOM environment and return the result. " +
        "This is a DOM environment (window/document/timers/DOM APIs), NOT Node.js - no require, no process, no fs. " +
        "Network access is blocked (fetch/XHR/WebSocket are unavailable). " +
        "The code runs as an async function body: use `return` to produce the result (top-level `await` is allowed); " +
        "the returned value is serialized to JSON (functions/DOM nodes become descriptive placeholders). " +
        "Hard limits: 32757 bytes of code (UTF-8), 10 second timeout, 64KB result cap (truncated). " +
        "Each call runs in a fresh, isolated environment - state does not persist between calls. " +
        "The user is asked to confirm before execution.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "JavaScript source to evaluate. It runs as an async function body (use return to produce the result; top-level await is allowed). Max 32757 bytes (UTF-8).",
          },
        },
        required: ["code"],
      },
      execute: async (args, ctx) => {
        const code = asString(args.code)
        if (!code.trim()) return { ok: false, error: "Missing required argument: code" }
        const sizeBytes = utf8ByteLength(code)
        if (sizeBytes > EVAL_LIMITS.maxCodeBytes) {
          return {
            ok: false,
            error: `code_too_large: code exceeds ${EVAL_LIMITS.maxCodeBytes} bytes (UTF-8); shorten the code and try again`,
          }
        }
        // Approval runs the frozen code snapshot (rule 4): nothing is re-read or re-derived after Approve.
        const approved = await requestEvalConfirmation({
          tool: "run_javascript",
          toolCallId: ctx.toolCallId,
          projectId,
          convId: ctx.convId,
          code,
        })
        if (!approved) return { ok: false, rejected: true, error: "The user rejected this execution request" }
        return requestEval(ctx.toolCallId, code, ctx.signal)
      },
    },
  ]
}
