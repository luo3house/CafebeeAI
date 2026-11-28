/**
 * Path utilities: pure string-level join / absolute-path validation (platform FS agnostic, easy to test and statically analyze).
 */
import { lookup } from "mrmime"

export function join(...segments: string[]): string {
  return segments.filter((s) => s.length > 0).join("/")
}

export function joinNative(...segments: string[]): string {
  return join(...segments).replace(/\//g, "/")
}

/**
 * Normalize escape literals such as `../` before validation.
 * Handles "relative segments" only: returns the slash-normalized path with `.`/`..` resolved (keeping the relative-to-project-root semantics).
 */
export function normalizeRelativePath(relPath: string): string {
  const parts = relPath.split("/")
  const stack: string[] = []
  for (const part of parts) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.join("/")
}

export function isSubPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath)
  return normalized.length > 0 && !normalized.startsWith("../") && normalized !== ".."
}

export function extname(filename: string): string {
  const idx = filename.lastIndexOf(".")
  return idx >= 0 ? filename.slice(idx).toLowerCase() : ""
}

export function basename(path: string): string {
  const parts = path.split("/")
  return parts[parts.length - 1] || ""
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").trim()
}

/**
 * App-reserved path segments: git internals are never user-managed - hidden from the Files list,
 * off-limits to the file tools, and refused as a created / renamed name.
 */
export const RESERVED_SEGMENTS = new Set([".git"])

/**
 * Extensions that merely HINT "this is text". **This is not a gate** - whether a file may be fed to
 * the model is decided by its content (`core/file-sniff.ts`), because a whitelist can never be
 * complete (it used to reject `Makefile`, extension-less scripts and `.svg`, while happily passing
 * a PNG renamed to `.md`). Two consumers remain, both name-only by nature: FilePreview's layout
 * pick and `mimeForFile`'s text/plain layer.
 */
export const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".yaml", ".yml", ".xml", ".toml", ".ini", ".cfg", ".csv", ".tsv",
  ".html", ".htm", ".css", ".scss", ".less", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".pyw", ".java", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".sh", ".bash", ".zsh",
  ".sql", ".php", ".rb", ".swift", ".kt", ".kts", ".lua", ".pl", ".r", ".dart", ".jl", ".vue", ".svelte",
  // SVG is XML text (it used to sit in MIME_TYPES but not here, so read_file refused every .svg)
  ".svg", ".env", ".log", ".gitignore", ".dockerfile", "dockerfile",
])

/** Name-level "does this look like text" hint - NEVER a content gate. See the comment on TEXT_EXTENSIONS. */
export function isTextExtension(name: string): boolean {
  const lower = name.toLowerCase()
  if (TEXT_EXTENSIONS.has(lower)) return true
  const idx = lower.lastIndexOf(".")
  const ext = idx >= 0 ? lower.slice(idx) : ""
  return TEXT_EXTENSIONS.has(ext) || lower === ".env" || lower === "dockerfile"
}

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".heic": "image/heic", ".heif": "image/heif",
  ".ico": "image/x-icon", ".tiff": "image/tiff", ".tif": "image/tiff", ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
  ".webm": "video/webm", ".m4v": "video/x-m4v",
  ".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar",
  ".rar": "application/vnd.rar", ".7z": "application/x-7z-compressed",
}

/**
 * Extensions we are confident are NOT worth reading during a content search (images / media /
 * office / archives). Derived from MIME_TYPES so a future addition stays in sync, MINUS `.svg`,
 * which is XML text and must still be searchable. This list may only say "no need to look",
 * never "must not be read": anything absent from it is decided by actual content
 * (`core/file-sniff.ts`), so extension-less files and unknown extensions are no longer lost.
 */
const NON_TEXT_EXTENSIONS = new Set(
  Object.keys(MIME_TYPES).filter((ext) => ext !== ".svg")
)

/** False only for an extension we are sure is binary-shaped; everything else deserves a content read. */
export function isLikelyBinaryExtension(name: string): boolean {
  return NON_TEXT_EXTENSIONS.has(extname(name))
}

/**
 * MIME resolution, four layers in priority order:
 * 1. MIME_TYPES (office/media quirks; mrmime strips vendor `vnd.*`/`x-*` types, so keep this as an override table);
 * 2. text-extension hints -> text/plain (also fixes mrmime mapping `.ts` to the MPEG transport stream `video/mp2t`);
 * 3. mrmime (standard mime-db types: images/audio/video/long-tail);
 * 4. application/octet-stream.
 * Name-only and synchronous by design: the external-open path is the sole consumer, and a file whose
 * extension lies keeps `application/octet-stream` (see the file-sniff header for why there is no
 * content sniffing / magic-number table in this app).
 */
export function mimeForFile(name: string): string {
  const known = MIME_TYPES[extname(name)]
  if (known) return known
  if (isTextExtension(name)) return "text/plain"
  return lookup(name) ?? "application/octet-stream"
}

/**
 * Glob matching (tool layer): `*`/`?` do not cross `/`, `**` does; a glob with a trailing slash after `**` can match zero directory levels;
 * patterns without `/` match against the basename, patterns with `/` match against the relative path.
 */
export function matchGlob(pattern: string, relPath: string): boolean {
  const target = pattern.includes("/") ? relPath : basename(relPath)
  let re = ""
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++
        if (pattern[i + 1] === "/") {
          i++
          re += "(?:[^/]+/)*"
        } else {
          re += ".*"
        }
      } else {
        re += "[^/]*"
      }
    } else if (ch === "?") {
      re += "[^/]"
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += "\\" + ch
    } else {
      re += ch
    }
  }
  return new RegExp(`^${re}$`).test(target)
}