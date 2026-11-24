/**
 * Providers kind module for the unified YAML transfer (rule 38, added 2026-11-24): one
 * `kind: v1/provider` document per provider (the `openai_compatible` nested shape is preserved from the
 * retired `v1/providers` format — the singular rename is the breaking change; old files abort with an
 * explicit unknown-kind error, no alias import).
 *
 * Export: the secret fields are always PRESENT and placeholder-replaced with `-- DEDUCTED --`
 * (self-documenting round-trip shape) unless the export dialog's "Include secrets" checkbox opts in, in
 * which case real values (from EncryptedStorage) are written.
 * Import semantics for secrets (uniform with the other kinds): sentinel / absent / empty = "unspecified"
 * (update keeps the stored key/header value; create leaves the skeleton); only real non-sentinel values
 * write. A headers SECTION, when present, is authoritative for key presence on update (rows not listed
 * drop that header; listed rows with unspecified values keep stored values per key).
 * Matching follows the registry: a `spec.id` matching an existing provider updates it; a free id creates
 * preserving the id (`createWithId`, so prefer_provider references survive); no id creates a fresh one.
 */
import { z } from "zod"
import { kProviderRegistry, type LLMProvider, type ProviderInput } from "./providers"
import { kSecretStore } from "./secrets"
import { KIND_PROVIDER, DEDUCTED, isDeducted, ID_RE, renderStream } from "./transfer"

export const PROVIDERS_DOC_KIND = KIND_PROVIDER

const providerSpecSchema = z.object({
  id: z.string().regex(ID_RE, `id must match ${ID_RE.source}`).optional(),
  name: z.string().min(1).max(120),
  openai_compatible: z.object({
    endpoint: z.string().min(3).max(2048),
    secret: z.string().max(4096).optional(),
    headers: z.array(z.object({ key: z.string().min(1).max(128), value: z.string().max(4096).optional() })).max(64).optional(),
  }),
})

/** A real (non-sentinel, non-blank) secret value — anything else means "unspecified". */
function realSecret(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (isDeducted(value)) return undefined
  return value || undefined
}

/** One export document per provider; `withSecrets` (the Include-secrets checkbox) toggles plaintext values. */
async function providerDoc(provider: LLMProvider, withSecrets: boolean): Promise<{ kind: string; spec: Record<string, unknown> }> {
  const secrets = await kSecretStore().loadSecret(provider.id)
  const oc: Record<string, unknown> = {
    endpoint: provider.baseURL,
    secret: withSecrets && secrets.apiKey ? secrets.apiKey : DEDUCTED,
  }
  const headerRows = Object.entries(secrets.headers ?? {}).map(([key, value]) => ({
    key,
    value: withSecrets && value ? value : DEDUCTED,
  }))
  if (headerRows.length > 0) oc.headers = headerRows
  return { kind: PROVIDERS_DOC_KIND, spec: { id: provider.id, name: provider.name, openai_compatible: oc } }
}

/** Render the whole registry as a YAML stream; secrets deduced unless the export opts in (async: EncryptedStorage). */
export async function renderProvidersYaml(withSecrets: boolean): Promise<string> {
  const docs = await Promise.all(kProviderRegistry().getAll().map((p) => providerDoc(p, withSecrets)))
  return renderStream(docs)
}

/** Registry entry: schema check + a self-contained apply thunk (or an en-US row error). */
export function providerTransfer(spec: unknown): { apply?: () => Promise<"created" | "updated">; message?: string } {
  const parsed = providerSpecSchema.safeParse(spec)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue?.path?.length ? ` at ${issue.path.join(".")}` : ""
    return { message: `invalid provider document${at}: ${issue?.message ?? "schema mismatch"}` }
  }
  const data = parsed.data
  return {
    apply: async () => {
      const registry = kProviderRegistry()
      const apiKey = realSecret(data.openai_compatible.secret)
      const existing = data.id ? registry.getById(data.id) : undefined
      const input: ProviderInput = { name: data.name.trim() || "Untitled Provider", baseURL: data.openai_compatible.endpoint }
      if (existing) {
        // Update keeps stored secrets where unspecified; a listed headers section applies row-by-row against the
        // stored map (unspecified listed values fall back to stored; missing rows drop that header).
        const prev = await kSecretStore().loadSecret(existing.id)
        let headers = prev.headers
        const rows = data.openai_compatible.headers
        if (rows && rows.length > 0) {
          const map: Record<string, string> = {}
          for (const row of rows) {
            const key = row.key.trim()
            if (!key) continue
            map[key] = realSecret(row.value) ?? prev.headers?.[key] ?? ""
          }
          headers = Object.keys(map).length > 0 ? map : undefined
        }
        await registry.update(existing.id, { ...input, apiKey, headers })
        return "updated" as const
      }
      const createHeadersFor = createHeaders(data.openai_compatible.headers)
      if (data.id) {
        await registry.createWithId(data.id, { ...input, apiKey, headers: createHeadersFor })
        return "created" as const
      }
      await registry.create({ ...input, apiKey, headers: createHeadersFor })
      return "created" as const
    },
  }
}

/** Create-time header map: only real values are written (unspecified rows simply do not exist yet). */
function createHeaders(rows: { key: string; value?: string }[] | undefined): Record<string, string> | undefined {
  if (!rows) return undefined
  const map: Record<string, string> = {}
  let any = false
  for (const row of rows) {
    const key = row.key.trim()
    const value = realSecret(row.value)
    if (!key || value === undefined) continue
    map[key] = value
    any = true
  }
  return any ? map : undefined
}
