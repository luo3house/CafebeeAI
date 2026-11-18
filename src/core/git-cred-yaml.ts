/**
 * YAML template + zod validation for Git credential entry (Settings > Global Git Config > Git Credentials).
 *
 * ONE unified template with three `uses_*` blocks - username+password / personal access token / SSH key pair -
 * of which EXACTLY ONE may be filled ("at most one, at least one"). Unfilled blocks stay at their template
 * placeholders (`xxxx` / the PEM placeholder) and do not count as filled. Both HTTPS blocks authenticate over
 * HTTP Basic (the token rides in the password slot), so the wire payload is identical; the split exists for
 * entry ergonomics and per-host username conventions.
 *
 * Create/edit goes through the full-screen TextEditor (rule 30: multi-line payloads never live in dialog
 * textareas): the caller navigates with `credTemplate`/`renderCredYaml` as `initialText`, passes `parseCredYaml`
 * as `validate`, and writes the parsed fields into kGitCredentialStore from `onSave` (secrets therefore go to
 * EncryptedStorage only, rule 29 - the YAML text itself is never persisted).
 */
import YAML from "yaml"
import { z } from "zod"

export interface UserPassCredDoc {
  kind: "userpass"
  name: string
  hostPrefix?: string
  username: string
  password: string
}

export interface AccessTokenCredDoc {
  kind: "accessToken"
  name: string
  hostPrefix?: string
  username: string
  token: string
}

export interface SshKeyCredDoc {
  kind: "sshKey"
  name: string
  hostPrefix?: string
  sshUser?: string
  passphrase?: string
  publicKey: string
  privateKey: string
}

export type UnifiedCredDoc = UserPassCredDoc | AccessTokenCredDoc | SshKeyCredDoc

export type CredParseResult<T> = { ok: true; value: T } | { ok: false; message: string }

const FIELD_PLACEHOLDER = "xxxx"
const PRIVATE_KEY_PLACEHOLDER = "paste the full PEM here"
const PUBLIC_KEY_PLACEHOLDER = "AAAA... user@host"

/** Block keys, in template order */
const BLOCK_KEYS = ["uses_username", "uses_personal_access_token", "uses_ssh_key"] as const
type BlockKey = (typeof BLOCK_KEYS)[number]

function placeholderBlock(key: BlockKey, hostPrefix: string): Record<string, unknown> {
  if (key === "uses_username") {
    return { host_prefix: hostPrefix, username: FIELD_PLACEHOLDER, password: FIELD_PLACEHOLDER }
  }
  if (key === "uses_personal_access_token") {
    return { host_prefix: hostPrefix, username: FIELD_PLACEHOLDER, token: FIELD_PLACEHOLDER }
  }
  return {
    host_prefix: hostPrefix,
    ssh_user: "",
    passphrase: "",
    public_key: `ssh-ed25519 ${PUBLIC_KEY_PLACEHOLDER}`,
    private_key: `-----BEGIN OPENSSH PRIVATE KEY-----\n-${PRIVATE_KEY_PLACEHOLDER}-\n-----END OPENSSH PRIVATE KEY-----`,
  }
}

/**
 * Blank unified template. When `key` is given (ed25519 auto-generation), the SSH block is filled with the
 * PEM/OpenSSH values as YAML block scalars (the other two stay at placeholders, so exactly one block is in use).
 */
export function credTemplate(key?: { publicLine: string; privatePem: string }): string {
  const doc: Record<string, unknown> = { name: "my-github" }
  doc.uses_username = placeholderBlock("uses_username", "github.com")
  doc.uses_personal_access_token = placeholderBlock("uses_personal_access_token", "github.com")
  doc.uses_ssh_key = key
    ? {
        host_prefix: "github.com",
        ssh_user: "",
        passphrase: "",
        public_key: key.publicLine,
        private_key: key.privatePem,
      }
    : placeholderBlock("uses_ssh_key", "github.com")
  return [
    "# Git credential - fill name and exactly ONE uses_* block (username+password / personal access token / SSH key).",
    "# Unfilled blocks stay at their xxxx placeholders and are ignored; host_prefix is optional",
    "# (the credential is suggested first for remotes under that host).",
    YAML.stringify(doc),
  ].join("\n")
}

/** Re-entry rendering for editing an existing credential (stringify keeps literal block scalars for PEMs). */
export function renderCredYaml(doc: UnifiedCredDoc): string {
  const out: Record<string, unknown> = { name: doc.name }
  out.uses_username =
    doc.kind === "userpass"
      ? { host_prefix: doc.hostPrefix ?? "", username: doc.username, password: doc.password }
      : placeholderBlock("uses_username", "github.com")
  out.uses_personal_access_token =
    doc.kind === "accessToken"
      ? { host_prefix: doc.hostPrefix ?? "", username: doc.username, token: doc.token }
      : placeholderBlock("uses_personal_access_token", "github.com")
  out.uses_ssh_key =
    doc.kind === "sshKey"
      ? {
          host_prefix: doc.hostPrefix ?? "",
          ssh_user: doc.sshUser ?? "",
          passphrase: doc.passphrase ?? "",
          public_key: doc.publicKey,
          private_key: doc.privateKey,
        }
      : placeholderBlock("uses_ssh_key", "github.com")
  return `# Git credential (fill exactly ONE uses_* block)\n${YAML.stringify(out)}`
}

function fieldFilled(field: string, value: unknown): boolean {
  if (typeof value !== "string") return false
  const v = value.trim()
  if (!v) return false
  if ((field === "username" || field === "password" || field === "token") && v === FIELD_PLACEHOLDER) return false
  if (field === "private_key" && v.includes(PRIVATE_KEY_PLACEHOLDER)) return false
  if (field === "public_key" && v.includes(PUBLIC_KEY_PLACEHOLDER)) return false
  return true
}

const BLOCK_FIELDS: Record<BlockKey, string[]> = {
  uses_username: ["username", "password"],
  uses_personal_access_token: ["username", "token"],
  uses_ssh_key: ["ssh_user", "passphrase", "public_key", "private_key"],
}

function blockInUse(key: BlockKey, block: unknown): boolean {
  if (!block || typeof block !== "object" || Array.isArray(block)) return false
  const rec = block as Record<string, unknown>
  return BLOCK_FIELDS[key].some((f) => fieldFilled(f, rec[f]))
}

function zodMessage(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return "The YAML did not pass validation"
  const path = issue.path.join(".")
  return path ? `${path}: ${issue.message}` : issue.message
}

const nameSchema = z.string().trim().min(1, "cannot be empty")
const hostPrefixSchema = z.string().trim().optional()

const userPassSchema = z.object({
  name: nameSchema,
  host_prefix: hostPrefixSchema,
  username: z.string().trim().min(1, "cannot be empty"),
  password: z.string().min(1, "cannot be empty"),
})

const accessTokenSchema = z.object({
  name: nameSchema,
  host_prefix: hostPrefixSchema,
  username: z.string().trim().min(1, "cannot be empty"),
  token: z.string().min(1, "cannot be empty"),
})

const sshKeySchema = z.object({
  name: nameSchema,
  host_prefix: hostPrefixSchema,
  ssh_user: z.string().trim().optional(),
  passphrase: z.string().optional(),
  public_key: z.string().optional(),
  private_key: z.string().min(1, "cannot be empty"),
})

function cleanHostPrefix(v?: string): string | undefined {
  const t = (v ?? "").trim()
  return t || undefined
}

export function parseCredYaml(text: string): CredParseResult<UnifiedCredDoc> {
  let rawDoc: unknown
  try {
    rawDoc = YAML.parse(text)
  } catch (err) {
    const e = err as Error
    // yaml syntax errors carry the offending snippet + caret line; keep the notice body compact
    return { ok: false, message: `Invalid YAML: ${(e?.message ?? String(err)).split("\n")[0]}` }
  }
  if (rawDoc === null || typeof rawDoc !== "object" || Array.isArray(rawDoc)) {
    return { ok: false, message: "Expected a YAML mapping with the fields listed in the template" }
  }
  const doc = rawDoc as Record<string, unknown>
  for (const key of BLOCK_KEYS) {
    const block = doc[key]
    if (block !== undefined && block !== null && (typeof block !== "object" || Array.isArray(block))) {
      return { ok: false, message: `${key}: expected a mapping with the fields listed in the template` }
    }
  }
  const inUse = BLOCK_KEYS.filter((key) => blockInUse(key, doc[key]))
  if (inUse.length === 0) {
    return { ok: false, message: "Fill exactly one of the three uses_* blocks (all are still at their placeholders)" }
  }
  if (inUse.length > 1) {
    return { ok: false, message: "Fill exactly one of the three uses_* blocks (more than one is in use)" }
  }
  const key = inUse[0]
  const block = doc[key] as Record<string, unknown>
  const base = { name: doc.name, host_prefix: block.host_prefix }

  if (key === "uses_username") {
    const parsed = userPassSchema.safeParse({ ...block, name: base.name, host_prefix: base.host_prefix })
    if (!parsed.success) return { ok: false, message: zodMessage(parsed.error) }
    const d = parsed.data
    if (d.password === FIELD_PLACEHOLDER) {
      return { ok: false, message: "password is still the template placeholder - enter the real password or token" }
    }
    return {
      ok: true,
      value: { kind: "userpass", name: d.name, hostPrefix: cleanHostPrefix(d.host_prefix), username: d.username, password: d.password },
    }
  }

  if (key === "uses_personal_access_token") {
    const parsed = accessTokenSchema.safeParse({ ...block, name: base.name, host_prefix: base.host_prefix })
    if (!parsed.success) return { ok: false, message: zodMessage(parsed.error) }
    const d = parsed.data
    if (d.token === FIELD_PLACEHOLDER) {
      return { ok: false, message: "token is still the template placeholder - enter the real access token" }
    }
    return {
      ok: true,
      value: { kind: "accessToken", name: d.name, hostPrefix: cleanHostPrefix(d.host_prefix), username: d.username, token: d.token },
    }
  }

  const parsed = sshKeySchema.safeParse({ ...block, name: base.name, host_prefix: base.host_prefix })
  if (!parsed.success) return { ok: false, message: zodMessage(parsed.error) }
  const d = parsed.data
  const privateKey = d.private_key.replace(/\s+$/, "")
  const publicKey = (d.public_key ?? "").replace(/\s+$/, "")
  if (!privateKey.includes("BEGIN")) {
    return { ok: false, message: "private_key does not look like a PEM block (missing -----BEGIN ...----- line)" }
  }
  if (privateKey.includes(PRIVATE_KEY_PLACEHOLDER)) {
    return { ok: false, message: "private_key is still the template placeholder - paste a real key, or go back and enable key generation" }
  }
  if (publicKey.includes(PUBLIC_KEY_PLACEHOLDER)) {
    return { ok: false, message: "public_key is still the template placeholder - fill in the real OpenSSH public line (or remove the public_key block if you have none)" }
  }
  return {
    ok: true,
    value: {
      kind: "sshKey",
      name: d.name,
      hostPrefix: cleanHostPrefix(d.host_prefix),
      sshUser: d.ssh_user || undefined,
      passphrase: d.passphrase || undefined,
      publicKey,
      privateKey,
    },
  }
}
