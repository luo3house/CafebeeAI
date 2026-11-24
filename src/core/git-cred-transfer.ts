/**
 * Git credentials kind module for the unified YAML transfer (rule 38): one `kind: v1/git_credential` document
 * per credential. Separate from git-cred-yaml.ts — that one is the uses_* CREATE TEMPLATE; this is the export
 * / import stream with a normalized per-entry spec (type discriminator + flat fields).
 *
 * Secret handling (decided 2026-11-24, final): `password` / `token` / `private_pem` / `passphrase` are exported
 * as the `-- DEDUCTED --` sentinel unless the export dialog's "Include secrets" checkbox opts in. `public_key`
 * is plain text ALWAYS (it is public metadata the user pastes into host accounts). The in-app editing path is
 * untouched: the row menu's Edit opens the full-plaintext uses_* template (rule 34 — the sanctioned way to
 * view/copy key material), and the generator flow keeps its one-time plaintext show.
 *
 * Import: unspecified (sentinel / absent / empty) secret fields keep the stored value on update and are simply
 * missing on create (skeleton tolerance, Q16); only real values write. Matching: id hit updates, free/absent id
 * creates preserving the id — credential NAMES carry no uniqueness constraint, so no name-collision rule.
 * accessToken is exported under the wire type `access_token` but stored in the same EncryptedStorage
 * `password` slot as userpass (rule 34 presentation flavor).
 */
import { z } from "zod"
import { kGitCredentialStore, type GitCredentialMeta, type GitCredentialType, type GitCredentialSecret } from "./git-credentials"
import { KIND_GIT_CREDENTIAL, DEDUCTED, isDeducted, ID_RE, renderStream } from "./transfer"

export const GIT_CRED_DOC_KIND = KIND_GIT_CREDENTIAL

const credSpecSchema = z.object({
  id: z.string().regex(ID_RE, `id must match ${ID_RE.source}`).optional(),
  name: z.string().trim().min(1, "cannot be empty").max(120),
  type: z.enum(["userpass", "access_token", "ssh_key"]),
  username: z.string().max(200).optional(),
  host_prefix: z.string().max(200).optional(),
  /** plain text always on export; import treats blank as unspecified */
  public_key: z.string().max(4096).optional(),
  password: z.string().max(4096).optional(),
  token: z.string().max(4096).optional(),
  private_pem: z.string().max(16384).optional(),
  passphrase: z.string().max(4096).optional(),
})

type CredSpec = z.infer<typeof credSpecSchema>

const WIRE_TO_STORE: Record<CredSpec["type"], GitCredentialType> = {
  userpass: "userpass",
  access_token: "accessToken",
  ssh_key: "sshKey",
}
const STORE_TO_WIRE: Record<GitCredentialType, CredSpec["type"]> = {
  userpass: "userpass",
  accessToken: "access_token",
  sshKey: "ssh_key",
}

/** Real (non-sentinel, non-blank) value — anything else is "unspecified". */
function real(value: string | undefined): string | undefined {
  if (value === undefined || isDeducted(value)) return undefined
  return value || undefined
}

async function credDoc(cred: GitCredentialMeta, withSecrets: boolean): Promise<{ kind: string; spec: Record<string, unknown> }> {
  const secret = await kGitCredentialStore().secretOf(cred.id)
  const spec: Record<string, unknown> = { id: cred.id, name: cred.name, type: STORE_TO_WIRE[cred.type] }
  if (cred.username) spec.username = cred.username
  if (cred.hostPrefix) spec.host_prefix = cred.hostPrefix
  const reveal = (stored: string | undefined): string => (withSecrets && stored ? stored : DEDUCTED)
  if (cred.type === "userpass") spec.password = reveal(secret?.password)
  else if (cred.type === "accessToken") spec.token = reveal(secret?.password)
  else {
    // public_key is plain text whenever present (never a secret); key half follows the Include-secrets rule
    if (cred.publicKey) spec.public_key = cred.publicKey
    spec.private_pem = reveal(secret?.privatePem)
    if (secret?.passphrase) spec.passphrase = reveal(secret.passphrase)
  }
  return { kind: GIT_CRED_DOC_KIND, spec }
}

/** Render every credential as a YAML stream; secrets deduced unless the export opts in (async: EncryptedStorage). */
export async function renderGitCredsYaml(withSecrets: boolean): Promise<string> {
  const docs = await Promise.all(kGitCredentialStore().list().map((c) => credDoc(c, withSecrets)))
  return renderStream(docs)
}

/** Registry entry: schema check + self-contained apply thunk. */
export function gitCredTransfer(spec: unknown): { apply?: () => Promise<"created" | "updated">; message?: string } {
  const parsed = credSpecSchema.safeParse(spec)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue?.path?.length ? ` at ${issue.path.join(".")}` : ""
    return { message: `invalid git_credential document${at}: ${issue?.message ?? "schema mismatch"}` }
  }
  const data = parsed.data
  return {
    apply: async () => {
      const store = kGitCredentialStore()
      const type = WIRE_TO_STORE[data.type]
      const existing = data.id ? store.get(data.id) : undefined
      if (existing) {
        // Merge-with-stored: a type's secret entry is rewritten ONLY when the document carries real values for
        // it (update replaces the whole entry, so partial secrets merge onto the current one).
        const realPassword = data.type === "userpass" ? real(data.password) : data.type === "access_token" ? real(data.token) : undefined
        const realPem = data.type === "ssh_key" ? real(data.private_pem) : undefined
        const realPassphrase = data.type === "ssh_key" ? real(data.passphrase) : undefined
        let secretPatch: GitCredentialSecret | undefined
        if (realPassword !== undefined || realPem !== undefined || realPassphrase !== undefined) {
          const prev = (await store.secretOf(existing.id)) ?? {}
          secretPatch = {
            password: realPassword ?? prev.password,
            privatePem: realPem ?? prev.privatePem,
            passphrase: realPassphrase ?? prev.passphrase,
          }
        }
        await store.update(existing.id, {
          name: data.name,
          type,
          ...(data.username !== undefined ? { username: data.username } : {}),
          ...(data.host_prefix !== undefined ? { hostPrefix: data.host_prefix } : {}),
          ...(data.type === "ssh_key" && data.public_key !== undefined && !isDeducted(data.public_key) ? { publicKey: data.public_key } : {}),
          ...(secretPatch ? { secret: secretPatch } : {}),
        })
        return "updated" as const
      }
      const input: Parameters<typeof store.create>[0] = { name: data.name, type }
      if (data.username) input.username = data.username
      if (data.host_prefix) input.hostPrefix = data.host_prefix
      if (data.type === "ssh_key" && !isDeducted(data.public_key) && data.public_key) input.publicKey = data.public_key
      const password = data.type === "userpass" ? real(data.password) : data.type === "access_token" ? real(data.token) : undefined
      const privatePem = data.type === "ssh_key" ? real(data.private_pem) : undefined
      const passphrase = data.type === "ssh_key" ? real(data.passphrase) : undefined
      if (password || privatePem || passphrase) input.secret = { password, privatePem, passphrase }
      if (data.id) {
        await store.createWithId(data.id, input)
        return "created" as const
      }
      await store.create(input)
      return "created" as const
    },
  }
}
