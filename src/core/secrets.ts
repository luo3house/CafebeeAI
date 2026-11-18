/**
 * SecretStore: API keys and custom Header secrets, one EncryptedStorage entry per provider.
 * Storage: react-native-encrypted-storage (Android Keystore-backed EncryptedSharedPreferences / iOS Keychain).
 * Key scheme: `v1_provider_{provider-id}_secret`; `v1_provider_ids` holds the JSON manifest of ids that own a secret
 * (the native module cannot enumerate keys, so the manifest mirrors what load() restores).
 * The legacy plaintext <AppRoot>/secrets.json is a deliberate breaking change: it is deleted on load, keys must be re-entered.
 */
import EncryptedStorage from "react-native-encrypted-storage"
import { joinPath, appRootPath, exists, unlink } from "./fs"
import type { LLMProvider } from "./providers"
import { lazyInit } from "./lazy"

export interface ProviderSecrets {
  apiKey?: string
  headers?: Record<string, string>
}

export function providerSecretKey(providerId: string): string {
  return `v1_provider_${providerId}_secret`
}

/** Manifest of provider ids that have a secret stored (the only enumerable index into EncryptedStorage) */
const IDS_KEY = "v1_provider_ids"

function secretsEmpty(s: ProviderSecrets): boolean {
  return !s.apiKey && !Object.values(s.headers ?? {}).some((v) => !!v)
}

class SecretStore {
  private cache: Record<string, ProviderSecrets> = {}
  private ids: string[] = []

  async load(): Promise<void> {
    // Breaking change (by design): plaintext secrets.json is retired — remove any leftover from old builds.
    try {
      const legacy = joinPath(appRootPath(), "secrets.json")
      if (await exists(legacy)) await unlink(legacy)
    } catch {
      // best-effort cleanup, never blocks startup
    }
    this.cache = {}
    this.ids = await this.readManifest()
    for (const id of this.ids) {
      const secrets = await this.read(id)
      if (secrets) this.cache[id] = secrets
    }
  }

  private async readManifest(): Promise<string[]> {
    try {
      const raw = await EncryptedStorage.getItem(IDS_KEY)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
    } catch {
      return []
    }
  }

  private async writeManifest(): Promise<void> {
    await EncryptedStorage.setItem(IDS_KEY, JSON.stringify(this.ids))
  }

  private async read(providerId: string): Promise<ProviderSecrets | null> {
    try {
      const raw = await EncryptedStorage.getItem(providerSecretKey(providerId))
      if (!raw) return null
      const parsed = JSON.parse(raw) as ProviderSecrets
      return parsed && typeof parsed === "object" ? parsed : null
    } catch {
      return null
    }
  }

  get(providerId: string): ProviderSecrets {
    return this.cache[providerId] ?? {}
  }

  /** Async read for callers (the provider form hydration) — falls back to EncryptedStorage, keeping the memory cache authoritative after load. */
  async loadSecret(providerId: string): Promise<ProviderSecrets> {
    if (this.cache[providerId]) return this.cache[providerId]
    const fresh = await this.read(providerId)
    if (fresh && !Object.prototype.hasOwnProperty.call(this.cache, providerId)) this.cache[providerId] = fresh
    return fresh ?? {}
  }

  async set(providerId: string, payload: ProviderSecrets): Promise<void> {
    const prev = this.cache[providerId] ?? {}
    const next: ProviderSecrets = { ...prev, ...payload }
    if (secretsEmpty(next)) {
      await this.remove(providerId)
      return
    }
    await EncryptedStorage.setItem(providerSecretKey(providerId), JSON.stringify(next))
    this.cache[providerId] = next
    if (!this.ids.includes(providerId)) {
      this.ids.push(providerId)
      await this.writeManifest()
    }
  }

  async remove(providerId: string): Promise<void> {
    try {
      await EncryptedStorage.removeItem(providerSecretKey(providerId))
    } catch {
      // key may not exist
    }
    delete this.cache[providerId]
    this.ids = this.ids.filter((x) => x !== providerId)
    await this.writeManifest()
  }

  /**
   * Rebuild the secret storage against the live provider list (update / delete / import all best-effort call this):
   * read each live provider's secret directly by key, clear() the store, then re-write only what belongs to a
   * live provider — so the storage can never keep an orphan secret, even if the manifest itself went stale.
   * Providers without a stored secret are simply "not configured" and untouched.
   * Never throws: a failed rebuild must not roll back the already-persisted provider change.
   */
  async rebuild(providerIds: string[]): Promise<void> {
    try {
      const entries = await Promise.all(
        providerIds.map(async (id) => [id, await this.read(id)] as const)
      )
      await EncryptedStorage.clear()
      this.cache = {}
      this.ids = []
      for (const [id, secrets] of entries) {
        if (!secrets || secretsEmpty(secrets)) continue
        await EncryptedStorage.setItem(providerSecretKey(id), JSON.stringify(secrets))
        this.cache[id] = secrets
        this.ids.push(id)
      }
      await this.writeManifest()
    } catch (err) {
      console.warn("Secret storage rebuild failed", err)
    }
  }

  buildHeaders(provider: LLMProvider, extra: Record<string, string> = {}, override?: ProviderSecrets): Record<string, string> {
    const secrets = override ?? this.get(provider.id)
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...extra,
    }
    if (secrets.apiKey) headers.authorization = `Bearer ${secrets.apiKey}`
    for (const [k, v] of Object.entries(secrets.headers ?? {})) {
      if (v) headers[k] = v
    }
    return headers
  }
}

export const kSecretStore = lazyInit<SecretStore>(() => new SecretStore())
