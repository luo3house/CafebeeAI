/**
 * Unified App-level YAML transfer engine (rule 38): the shared skeleton every `v1/...` document stream rides on.
 *
 * Format (breaking change 2026-11-24 — files exported by rule 30's old `v1/providers` format are rejected with
 * an explicit unknown-kind error, no alias import): `---`-separated YAML documents, each `{ kind, spec }` with
 * snake_case spec keys. Five kinds are live: `v1/provider`, `v1/git_credential`, `v1/system_prompt`,
 * `v1/skill`, `v1/app_settings`.
 *
 * Secret handling: export REPLACES each secret value with the sentinel string `-- DEDUCTED --` unless the export
 * dialog's "Include secrets" checkbox opts in. Import semantics for secret fields are uniform:
 * sentinel / absent / empty string = "unspecified" (update keeps the stored value, create leaves the skeleton);
 * only a real, non-sentinel value writes. `public_key` (git credentials) is plain text everywhere - see rule 38.
 *
 * Import error model: file-level structure failures (YAML syntax error, non-mapping document, unknown kind)
 * ABORT the whole import atomically - precheck runs before any write. Per-document schema errors are collected
 * (`document #n (v1/kind): message`); documents of a known-but-unaccepted kind count as `skipped` (the kind-routed
 * page applies only its own kinds; Settings' "Import data" accepts all five).
 *
 * This module holds only the envelope, the sentinel, staging/reading and the router. The five kind modules
 * (providers-transfer / git-cred-transfer / prompts-transfer / skills-transfer / app-settings) import these
 * primitives and export a self-validating `apply(raw)` thunk with no back-reference into this file. The registry
 * (src/core/transfer-registry.ts) assembles them and owns the stream renderers.
 */
import YAML from "yaml"
import ReactNativeBlobUtil from "react-native-blob-util"
import { sweepShareCache } from "./import-export"
import { joinPath, ensureDir, writeText, readText } from "./fs"

/** Sentinel written in place of a secret when "Include secrets" is off (rule 38). */
export const DEDUCTED = "-- DEDUCTED --"

/** The five live document kinds (rule 38; singular, breaking rename from `v1/providers`). */
export const KIND_PROVIDER = "v1/provider"
export const KIND_GIT_CREDENTIAL = "v1/git_credential"
export const KIND_SYSTEM_PROMPT = "v1/system_prompt"
export const KIND_SKILL = "v1/skill"
export const KIND_APP_SETTINGS = "v1/app_settings"
export const ALL_KINDS = [KIND_PROVIDER, KIND_GIT_CREDENTIAL, KIND_SYSTEM_PROMPT, KIND_SKILL, KIND_APP_SETTINGS] as const

/** True when the value is the sentinel (trim-tolerant) — callers then treat the field as unspecified. */
export function isDeducted(value: unknown): boolean {
  return typeof value === "string" && value.trim() === DEDUCTED
}

/** Shared id grammar across the per-entry kinds (also matches uuid32 / builtin-* reserved ids). */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const CACHE_EXPORT_SUBDIR = "exports"
const MAX_IMPORT_BYTES = 2 * 1024 * 1024

export interface TransferReport {
  created: number
  updated: number
  skipped: number
  errors: string[]
}

export function emptyReport(): TransferReport {
  return { created: 0, updated: 0, skipped: 0, errors: [] }
}

/** File-level failure: the stream is structurally unusable, so NOTHING is applied (atomic abort). */
export class TransferAbortError extends Error {}

/** A document whose kind this surface does not host (newer app version / foreign namespace) — not "skipped". */
export function unknownKindMessage(kindLabel: string, index: number): string {
  return `document #${index + 1} has kind ${kindLabel}, which this version cannot import (update the app or remove the document)`
}

export function isSupportedKind(kind: unknown): kind is string {
  return typeof kind === "string" && (ALL_KINDS as readonly string[]).includes(kind)
}

/** A validated document + enough context to label errors and route application. */
export interface LoadedDoc {
  index: number
  kind: string
  apply: () => Promise<"created" | "updated">
}

export interface LoadedStream {
  docs: LoadedDoc[]
  /** Known kinds this surface does not host — counted as skipped. */
  skipped: number
  errors: string[]
}

/**
 * The registry wires every kind into this shape: `validate` performs the schema check and, when the document
 * is usable, returns a self-contained `apply` thunk (typed spec already captured) — the engine never re-parses.
 * A returned `message` is an entry-level error (document skipped + reported), not a file-level failure.
 */
export interface KindAdapter {
  validate(spec: unknown): { apply?: () => Promise<"created" | "updated">; message?: string }
}

/**
 * Parse the stream, classify every document by kind, validate accepted kinds — WITHOUT applying anything.
 * `accept(kind)` answers "does this surface import this kind?" (single-kind pages accept one kind;
 * Settings accepts all five). Any structural failure (syntax error, non-mapping document, an unlisted kind)
 * throws TransferAbortError so the whole import aborts with zero writes. Accepted-but-invalid documents are
 * collected per row (`document #n (kind): ...`) so the rest still applies; known-but-unaccepted kinds count
 * as skipped.
 */
export function loadStream(text: string, accept: (kind: string) => boolean, modules: Record<string, KindAdapter>): LoadedStream {
  const docs: LoadedDoc[] = []
  let skipped = 0
  const errors: string[] = []

  let rawDocs = YAML.parseAllDocuments(text)
  if (rawDocs.length === 0) rawDocs = [YAML.parseDocument(text)]

  for (let idx = 0; idx < rawDocs.length; idx++) {
    const raw = rawDocs[idx]
    if (raw.errors.length > 0) {
      throw new TransferAbortError(`document #${idx + 1}: YAML syntax error (${raw.errors[0].message.split("\n")[0]})`)
    }
    const value = raw.toJS()
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TransferAbortError(`document #${idx + 1}: expected a mapping with "kind" and "spec"`)
    }
    const kind = (value as { kind?: unknown }).kind
    if (typeof kind !== "string" || !(kind in modules)) {
      throw new TransferAbortError(unknownKindMessage(String(kind ?? "(missing)"), idx))
    }
    const spec = (value as { spec?: unknown }).spec
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      throw new TransferAbortError(`document #${idx + 1} (${kind}): missing or malformed "spec" mapping`)
    }
    if (!accept(kind)) {
      skipped++
      continue
    }
    const result = modules[kind].validate(spec)
    if (!result.apply) {
      errors.push(`document #${idx + 1} (${kind}): ${result.message ?? "invalid document"}`)
      continue
    }
    const apply = result.apply
    docs.push({ index: idx, kind, apply })
  }

  return { docs, skipped, errors }
}

/**
 * Run the precheck pass and, only if the stream survived (no abort), apply every valid document in order.
 * Returns the report (created/updated/skipped/errors) - callers surface errors>0 in a dialog, else a toast.
 */
export async function importStreamText(text: string, accept: (kind: string) => boolean, modules: Record<string, KindAdapter>): Promise<TransferReport> {
  const loaded = await loadStream(text, accept, modules)
  const report: TransferReport = { created: 0, updated: 0, skipped: loaded.skipped, errors: [...loaded.errors] }
  for (const doc of loaded.docs) {
    const label = `document #${doc.index + 1} (${doc.kind})`
    try {
      const outcome = await doc.apply()
      if (outcome === "created") report.created++
      else report.updated++
    } catch (err: any) {
      report.errors.push(`${label}: ${String(err?.message ?? err)}`)
    }
  }
  return report
}

/** Render `{ kind, spec }` documents into a `---`-separated stream (export-side shape of loadStream). */
export function renderStream(docs: Array<{ kind: string; spec: unknown }>): string {
  return docs.map((doc) => `---\n${YAML.stringify(doc)}`).join("")
}

/** Read a picked local file (kept under MAX_IMPORT_BYTES) as text. */
export async function readTransferFile(localPath: string): Promise<string> {
  const raw = localPath.replace(/^file:\/\//, "")
  const text = await readText(raw)
  if (text.length > MAX_IMPORT_BYTES) throw new Error("Import file is too large (over 2 MB)")
  return text
}

/**
 * Stage a rendered stream into the share cache and return the snapshot path (File Preview flow, rule 30 -
 * the caller routes to FilePreview; "Open with..." shares from there, nothing auto-shares).
 * NOTE: when the export ran with "Include secrets" the staged file contains plaintext secrets; the 24h
 * sweepShareCache TTL bounds its lifetime.
 */
export async function stageTransferYaml(prefix: string, text: string): Promise<{ name: string; path: string }> {
  await sweepShareCache()
  const dir = joinPath(ReactNativeBlobUtil.fs.dirs.CacheDir, CACHE_EXPORT_SUBDIR)
  await ensureDir(dir)
  const name = `${prefix}-${Date.now()}.yaml`
  const outPath = joinPath(dir, name)
  await writeText(outPath, text)
  return { name, path: outPath }
}
