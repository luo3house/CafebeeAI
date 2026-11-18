/**
 * Providers settings transfer: YAML multi-document stream for the global provider registry.
 *
 * Export = one `kind: v1/providers` document per provider; NEVER includes secrets
 * (API key / custom header values live in EncryptedStorage only).
 * Import = the same document shape, zod-validated by kind + spec; import MAY carry `secret` +
 * header values, which are written into EncryptedStorage (`v1_provider_{provider-id}_secret`) —
 * never into providers.json. After any import the secret storage is rebuilt so no orphan keys remain.
 *
 * Document shape:
 * ---
 * kind: v1/providers
 * spec:
 *   id: xxxx              # optional; preserved on import when free, matched for update when taken
 *   name: provider1
 *   openai_compatible:
 *     endpoint: https://...
 *     secret: sk-...      # import-only
 *     headers:            # import-only (values are secrets)
 *       - { key: x-api-key, value: xxx }
 */
import YAML from "yaml"
import { z } from "zod"
import ReactNativeBlobUtil from "react-native-blob-util"
import { kProviderRegistry, type ProviderInput } from "./providers"
import { sweepShareCache } from "./import-export"
import { joinPath, ensureDir, writeText, readText } from "./fs"

const CACHE_EXPORT_SUBDIR = "exports"
const MAX_IMPORT_BYTES = 2 * 1024 * 1024

export const PROVIDERS_DOC_KIND = "v1/providers"

const headerRowSchema = z.object({
  key: z.string().min(1).max(128),
  value: z.string().max(4096).optional(),
})

const providerSpecSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "id must match [A-Za-z0-9_-]{1,64}")
    .optional(),
  name: z.string().min(1).max(120),
  openai_compatible: z.object({
    endpoint: z.string().min(3).max(2048),
    secret: z.string().max(4096).optional(),
    headers: z.array(headerRowSchema).max(64).optional(),
  }),
})

const providerDocSchema = z.object({
  kind: z.literal(PROVIDERS_DOC_KIND),
  spec: providerSpecSchema,
})

type ProviderSpec = z.infer<typeof providerSpecSchema>

function headersToMap(rows: ProviderSpec["openai_compatible"]["headers"]): Record<string, string> | undefined {
  if (!rows || rows.length === 0) return undefined
  const map: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    map[key] = row.value ?? ""
  }
  return Object.keys(map).length > 0 ? map : undefined
}

function specToInput(spec: ProviderSpec): ProviderInput {
  const oc = spec.openai_compatible
  return {
    name: spec.name,
    baseURL: oc.endpoint,
    apiKey: oc.secret,
    headers: headersToMap(oc.headers),
  }
}

/** One `---` document per provider, secrets never included (export is share/paste-safe). */
export function renderProvidersYaml(): string {
  const docs = kProviderRegistry().getAll().map((p) => ({
    kind: PROVIDERS_DOC_KIND,
    spec: {
      id: p.id,
      name: p.name,
      openai_compatible: { endpoint: p.baseURL },
    },
  }))
  return docs.map((doc) => `---\n${YAML.stringify(doc)}`).join("")
}

/**
 * Stage the rendered YAML into the share cache and return the snapshot path.
 * The caller shows it in the File Preview screen (code view); external open / share happens there ("Open with..."),
 * so this function never touches the share sheet itself.
 */
export async function stageProvidersYaml(): Promise<{ name: string; path: string }> {
  await sweepShareCache()
  const dir = joinPath(ReactNativeBlobUtil.fs.dirs.CacheDir, CACHE_EXPORT_SUBDIR)
  await ensureDir(dir)
  const name = `providers-${Date.now()}.yaml`
  const outPath = joinPath(dir, name)
  await writeText(outPath, renderProvidersYaml())
  return { name, path: outPath }
}

/** Read a picked local file (kept under MAX_IMPORT_BYTES) as text. */
export async function readProvidersYamlFile(localPath: string): Promise<string> {
  const raw = localPath.replace(/^file:\/\//, "")
  const text = await readText(raw)
  if (text.length > MAX_IMPORT_BYTES) throw new Error("Providers file is too large (over 2 MB)")
  return text
}

export interface ProvidersImportReport {
  created: number
  updated: number
  errors: string[]
}

/** One schema-valid document plus the source index it came from (for stable `document #n` error labels). */
export interface ParsedProviderDoc {
  index: number
  spec: ProviderSpec
}

async function applyDocSpec(spec: ProviderSpec): Promise<"created" | "updated"> {
  const registry = kProviderRegistry()
  const input = specToInput(spec)
  if (spec.id) {
    if (registry.getById(spec.id)) {
      await registry.update(spec.id, input)
      return "updated"
    }
    await registry.createWithId(spec.id, input)
    return "created"
  }
  await registry.create(input)
  return "created"
}

/**
 * Pre-check a YAML multi-document stream WITHOUT applying anything: returns the validated docs
 * (order-preserving, with their document index for error labels) plus per-document parse/schema errors.
 * Used by the paste-text import editor's async validate - ok means "every document is importable".
 */
export function parseProvidersYamlText(text: string): { docs: ParsedProviderDoc[]; errors: string[] } {
  const docs: ParsedProviderDoc[] = []
  const errors: string[] = []
  let rawDocs = YAML.parseAllDocuments(text)
  if (rawDocs.length === 0) rawDocs = [YAML.parseDocument(text)]
  for (let idx = 0; idx < rawDocs.length; idx++) {
    const doc = rawDocs[idx]
    const label = `document #${idx + 1}`
    if (doc.errors.length > 0) {
      errors.push(`${label}: ${doc.errors[0].message}`)
      continue
    }
    const parsed = providerDocSchema.safeParse(doc.toJS())
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const at = issue.path.join(".") || "(root)"
      errors.push(`${label}: invalid ${PROVIDERS_DOC_KIND} document (${at}: ${issue.message})`)
      continue
    }
    docs.push({ index: idx, spec: parsed.data.spec })
  }
  return { docs, errors }
}

/**
 * Apply previously parsed docs: a spec `id` that matches an existing provider updates it; a free (or absent) id
 * creates one, preserving the id when given so project prefer_provider references survive a round trip.
 * `secret` / header values go to EncryptedStorage only; the secret storage is rebuilt at the end.
 */
export async function importProvidersDocs(docs: ParsedProviderDoc[]): Promise<ProvidersImportReport> {
  const registry = kProviderRegistry()
  const report: ProvidersImportReport = { created: 0, updated: 0, errors: [] }
  for (const { index, spec } of docs) {
    const label = `document #${index + 1}`
    try {
      const outcome = await applyDocSpec(spec)
      if (outcome === "created") report.created++
      else report.updated++
    } catch (err: any) {
      report.errors.push(`${label}: ${String(err?.message ?? err)}`)
    }
  }
  await registry.rebuildSecretStorage()
  return report
}

/** Import a YAML multi-document stream end-to-end (parse + apply); invalid documents are reported and skipped individually. */
export async function importProvidersYaml(text: string): Promise<ProvidersImportReport> {
  const { docs, errors } = parseProvidersYamlText(text)
  const report = await importProvidersDocs(docs)
  return { ...report, errors: [...errors, ...report.errors] }
}
