/**
 * Git credential store: named global credentials (username+password / personal access token / SSH key pair)
 * shared by all projects. Non-secret metadata (id/name/type/username/publicKey/hostPrefix) lives in
 * `<appRoot>/git-credentials.json` (the file doubles as the manifest - EncryptedStorage cannot enumerate keys);
 * the secret half (password / token / private PEM / passphrase) lives one EncryptedStorage entry per credential
 * under `v1_git_{id}_secret` (same rule 29 contract as provider keys). Payloads handed to the native SDK are
 * assembled here per call; secrets never touch the sandbox file system.
 *
 * `accessToken` is a presentation-level flavor of `userpass`: both authenticate over HTTP Basic with the token
 * in the password slot, so both map to the SDK's `userpass` payload (zero native transport code per type).
 * `hostPrefix` is soft metadata (Q12): matching creds are suggested first for a remote's host, but nothing is
 * ever hard-bound - a mismatch only hints, it never blocks selection.
 */
import EncryptedStorage from "react-native-encrypted-storage"
import { joinPath, appRootPath, exists, readText, atomicWriteText } from "./fs"
import { uuid32 } from "./uuid"
import { lazyInit } from "./lazy"
import type { GitCredential } from "react-native-pocket-git"

export type GitCredentialType = "sshKey" | "userpass" | "accessToken"

export interface GitCredentialMeta {
  id: string
  name: string
  type: GitCredentialType
  username?: string
  publicKey?: string
  /** Soft host claim (e.g. "github.com"): exact-or-subdomain match against a remote's host for suggestion ordering */
  hostPrefix?: string
  createdAt: number
}

export interface GitCredentialSecret {
  password?: string
  privatePem?: string
  passphrase?: string
}

function metaPath(): string {
  return joinPath(appRootPath(), "git-credentials.json")
}

function secretKey(id: string): string {
  return `v1_git_${id}_secret`
}

function secretEmpty(s: GitCredentialSecret): boolean {
  return !s.password && !s.privatePem && !s.passphrase
}

function validMeta(value: unknown): value is GitCredentialMeta {
  const m = value as GitCredentialMeta
  return (
    !!m &&
    typeof m.id === "string" &&
    typeof m.name === "string" &&
    (m.type === "sshKey" || m.type === "userpass" || m.type === "accessToken")
  )
}

export function credentialTypeLabel(meta: GitCredentialMeta): string {
  if (meta.type === "sshKey") return "SSH key"
  if (meta.type === "accessToken") return "Personal access token"
  return "Username + password"
}

export function credentialTypeIcon(meta: GitCredentialMeta): string {
  if (meta.type === "sshKey") return "lock-open-variant-outline"
  if (meta.type === "accessToken") return "key-chain"
  return "account-key-outline"
}

/** Host part of a remote URL (https://host/... or git@host:...); null when it cannot be determined. */
export function hostOfUrl(url: string): string | null {
  const trimmed = url.trim()
  const http = /^[a-z][a-z0-9+.-]*:\/\/([^/@]+)/i.exec(trimmed)
  if (http) {
    const host = (http[1].split("@").pop() ?? "").split(":")[0].toLowerCase()
    return host || null
  }
  const scp = /^[^/@\s]+@([^/:]+):/i.exec(trimmed)
  if (scp) return scp[1].toLowerCase() || null
  return null
}

/** Soft host match: exact host or subdomain boundary ("github.com" matches "gist.github.com", not "mygithub.com"). */
export function credMatchesHost(meta: GitCredentialMeta, host: string | null): boolean {
  const prefix = meta.hostPrefix?.trim().toLowerCase()
  if (!prefix || !host) return false
  return host === prefix || host.endsWith(`.${prefix}`)
}

/** Suggestion ordering only: host-matching credentials first, the rest keep their order. */
export function sortCredsForHost(creds: GitCredentialMeta[], host: string | null): GitCredentialMeta[] {
  return [...creds].sort((a, b) => Number(credMatchesHost(b, host)) - Number(credMatchesHost(a, host)))
}

class GitCredentialStore {
  private metas: GitCredentialMeta[] = []
  private loaded = false

  async load(): Promise<void> {
    this.metas = []
    this.loaded = true
    try {
      if (!(await exists(metaPath()))) return
      const raw = await readText(metaPath())
      const doc = JSON.parse(raw) as { items?: unknown }
      const items = Array.isArray(doc?.items) ? doc.items : []
      this.metas = items.filter(validMeta)
    } catch {
      this.metas = []
    }
  }

  private async persist(): Promise<void> {
    await atomicWriteText(metaPath(), JSON.stringify({ kind: "v1/gitcredentials", items: this.metas }))
  }

  list(): GitCredentialMeta[] {
    return this.metas
  }

  get(id: string): GitCredentialMeta | undefined {
    return this.metas.find((m) => m.id === id)
  }

  async create(input: {
    name: string
    type: GitCredentialType
    username?: string
    publicKey?: string
    hostPrefix?: string
    secret?: GitCredentialSecret
  }): Promise<GitCredentialMeta> {
    const meta: GitCredentialMeta = {
      id: uuid32(),
      name: input.name.trim(),
      type: input.type,
      username: input.username || undefined,
      publicKey: input.publicKey || undefined,
      hostPrefix: input.hostPrefix || undefined,
      createdAt: Date.now(),
    }
    this.metas = [...this.metas, meta]
    await this.persist()
    if (input.secret && !secretEmpty(input.secret)) {
      await EncryptedStorage.setItem(secretKey(meta.id), JSON.stringify(input.secret))
    }
    return meta
  }

  /** `secret === null` explicitly clears the stored secret; `undefined` leaves it untouched. */
  async update(
    id: string,
    patch: {
      name?: string
      type?: GitCredentialType
      username?: string
      publicKey?: string
      hostPrefix?: string
      secret?: GitCredentialSecret | null
    },
  ): Promise<void> {
    const idx = this.metas.findIndex((m) => m.id === id)
    if (idx < 0) return
    const next: GitCredentialMeta = {
      ...this.metas[idx],
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.username !== undefined ? { username: patch.username || undefined } : {}),
      ...(patch.publicKey !== undefined ? { publicKey: patch.publicKey || undefined } : {}),
      ...(patch.hostPrefix !== undefined ? { hostPrefix: patch.hostPrefix || undefined } : {}),
    }
    const metas = [...this.metas]
    metas[idx] = next
    this.metas = metas
    await this.persist()
    if (patch.secret === null) {
      await this.removeSecret(id)
    } else if (patch.secret) {
      if (secretEmpty(patch.secret)) await this.removeSecret(id)
      else await EncryptedStorage.setItem(secretKey(id), JSON.stringify(patch.secret))
    }
  }

  async remove(id: string): Promise<void> {
    this.metas = this.metas.filter((m) => m.id !== id)
    await this.persist()
    await this.removeSecret(id)
  }

  private async removeSecret(id: string): Promise<void> {
    try {
      await EncryptedStorage.removeItem(secretKey(id))
    } catch {
      // key may not exist
    }
  }

  async secretOf(id: string): Promise<GitCredentialSecret | null> {
    try {
      const raw = await EncryptedStorage.getItem(secretKey(id))
      if (!raw) return null
      const parsed = JSON.parse(raw) as GitCredentialSecret
      return parsed && typeof parsed === "object" ? parsed : null
    } catch {
      return null
    }
  }

  /** SDK transport payload; a missing/unset credential degrades to anonymous. */
  async buildPayload(id?: string | null): Promise<GitCredential> {
    if (!id) return { type: "none" }
    const meta = this.get(id)
    if (!meta) return { type: "none" }
    const secret = await this.secretOf(id)
    if (meta.type === "userpass" || meta.type === "accessToken") {
      return { type: "userpass", username: secret?.password ? meta.username ?? "" : meta.username ?? "", password: secret?.password ?? "" }
    }
    return { type: "sshKey", username: meta.username || undefined, privatePem: secret?.privatePem ?? "", passphrase: secret?.passphrase }
  }
}

export const kGitCredentialStore = lazyInit<GitCredentialStore>(() => new GitCredentialStore())
