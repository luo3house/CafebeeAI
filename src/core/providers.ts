/**
 * Provider registry (global, providers.json at the app root). Contains no secrets.
 */
import { joinPath, readText, ensureDir, exists, atomicWriteText, appRootPath } from "./fs"
import { uuid32 } from "./uuid"
import { lazyInit } from "./lazy"
import { kSecretStore, type ProviderSecrets } from "./secrets"
export interface LLMProvider {
  id: string
  name: string
  baseURL: string // e.g. https://api.deepseek.com/v1
  modelNamesCache?: string[]
  createdAt: number
  updatedAt: number
}

export interface ProviderInput {
  name: string
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
}

class ProviderRegistry {
  private providers: LLMProvider[] = []

  async load(): Promise<void> {
    await ensureDir(appRootPath())
    const path = this.path()
    if (await exists(path)) {
      try {
        const raw = JSON.parse(await readText(path)) as { providers?: LLMProvider[] }
        this.providers = Array.isArray(raw.providers) ? raw.providers : []
      } catch {
        this.providers = []
      }
    }
  }

  private path(): string {
    return joinPath(appRootPath(), "providers.json")
  }

  private async persist(): Promise<void> {
    await atomicWriteText(this.path(), JSON.stringify({ providers: this.providers }, null, 2))
  }

  getAll(): LLMProvider[] {
    return [...this.providers].sort((a, b) => a.createdAt - b.createdAt)
  }

  getById(id: string): LLMProvider | undefined {
    return this.providers.find((p) => p.id === id)
  }

  async create(input: ProviderInput): Promise<LLMProvider> {
    const provider: LLMProvider = {
      id: uuid32(),
      name: input.name.trim() || "Untitled Provider",
      baseURL: normalizeBaseURL(input.baseURL),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.providers.push(provider)
    await this.persist()
    if (input.apiKey || input.headers) {
      await kSecretStore().set(provider.id, {
        apiKey: input.apiKey,
        headers: input.headers,
      })
    }
    return provider
  }

  /** Id-preserving create used by the Providers YAML import (a preserved id keeps project prefer_provider references valid) */
  async createWithId(id: string, input: ProviderInput): Promise<LLMProvider> {
    const provider: LLMProvider = {
      id,
      name: input.name.trim() || "Untitled Provider",
      baseURL: normalizeBaseURL(input.baseURL),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.providers.push(provider)
    await this.persist()
    if (input.apiKey || input.headers) {
      await kSecretStore().set(provider.id, {
        apiKey: input.apiKey,
        headers: input.headers,
      })
    }
    return provider
  }

  async update(id: string, input: Partial<ProviderInput>): Promise<LLMProvider | undefined> {
    const provider = this.getById(id)
    if (!provider) return undefined
    if (input.name !== undefined) provider.name = input.name.trim() || provider.name
    if (input.baseURL !== undefined) provider.baseURL = normalizeBaseURL(input.baseURL)
    provider.updatedAt = Date.now()
    await this.persist()
    if (input.apiKey !== undefined || input.headers !== undefined) {
      await kSecretStore().set(id, {
        apiKey: input.apiKey,
        headers: input.headers,
      })
    }
    await this.rebuildSecretStorage()
    return provider
  }

  async updateModelNames(id: string, modelNames: string[]): Promise<void> {
    const provider = this.getById(id)
    if (!provider) return
    provider.modelNamesCache = modelNames
    provider.updatedAt = Date.now()
    await this.persist()
  }

  async remove(id: string): Promise<void> {
    const idx = this.providers.findIndex((p) => p.id === id)
    if (idx !== -1) {
      this.providers.splice(idx, 1)
      await this.persist()
    }
    // Drop the deleted provider's secret, then rebuild so no orphan secret can remain from earlier paths (e.g. imports).
    await kSecretStore().rebuild(this.providers.map((p) => p.id))
  }

  /** Sweep orphan secrets against the current provider list (best-effort; see SecretStore.rebuild). */
  async rebuildSecretStorage(): Promise<void> {
    await kSecretStore().rebuild(this.providers.map((p) => p.id))
  }
}

export function normalizeBaseURL(url: string): string {
  let u = url.trim()
  if (!u.startsWith("http://") && !u.startsWith("https://")) u = `https://${u}`
  u = u.replace(/\/+$/, "")
  return u
}

export const kProviderRegistry = lazyInit<ProviderRegistry>(() => new ProviderRegistry())
/** `secrets` overrides the stored secret (the Provider form "Fetch" previews with the unsaved key/headers currently in the form). */
export async function listModels(provider: LLMProvider, secrets?: ProviderSecrets): Promise<string[]> {
  const headers = kSecretStore().buildHeaders(provider, {}, secrets)
  const url = `${provider.baseURL}/models`
  const res = await fetch(url, { method: "GET", headers: headers as Record<string, string> })
  if (!res.ok) {
    throw new Error(`Model list request failed: HTTP ${res.status} ${res.statusText}`)
  }
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error("Model list response is not valid JSON")
  }
  const data = json?.data
  if (!Array.isArray(data)) throw new Error("Model list response is missing the data array")
  return data.map((m: any) => typeof m.id === "string" ? m.id : "").filter(Boolean) as string[]
}