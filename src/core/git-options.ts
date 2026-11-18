/**
 * Global Git client options (non-secret): commit author identity, TLS verification, SSH host-key policy.
 * Stored in `<appRoot>/git-options.json`; the TOFU known_hosts file lives next to it (`git-known_hosts`).
 */
import { joinPath, appRootPath, exists, readText, atomicWriteText } from "./fs"
import { lazyInit } from "./lazy"
import Config from "react-native-config"

export type GitHostKeyPolicy = "tofu" | "skip"

export interface GitOptions {
  authorName: string
  authorEmail: string
  sslVerify: boolean
  hostKeyPolicy: GitHostKeyPolicy
}

export const DEFAULT_GIT_OPTIONS: GitOptions = {
  authorName: Config.APP_NAME || "CafebeeAI",
  authorEmail: "app@localhost",
  sslVerify: true,
  hostKeyPolicy: "tofu",
}

function optionsPath(): string {
  return joinPath(appRootPath(), "git-options.json")
}

export function gitKnownHostsPath(): string {
  return joinPath(appRootPath(), "git-known_hosts")
}

export async function readGitKnownHosts(): Promise<string> {
  try {
    if (!(await exists(gitKnownHostsPath()))) return ""
    return await readText(gitKnownHostsPath())
  } catch {
    return ""
  }
}

/** Write the full known_hosts content back (Manage Trusted Hosts page: per-line delete / add). */
export async function writeGitKnownHosts(text: string): Promise<void> {
  const body = text === "" || text.endsWith("\n") ? text : `${text}\n`
  await atomicWriteText(gitKnownHostsPath(), body)
}

class GitOptionsStore {
  private cache: GitOptions = { ...DEFAULT_GIT_OPTIONS }
  private loaded = false

  async load(): Promise<void> {
    this.loaded = true
    try {
      if (!(await exists(optionsPath()))) return
      const raw = await readText(optionsPath())
      const doc = JSON.parse(raw) as Partial<GitOptions>
      this.cache = {
        authorName: typeof doc.authorName === "string" && doc.authorName ? doc.authorName : DEFAULT_GIT_OPTIONS.authorName,
        authorEmail: typeof doc.authorEmail === "string" && doc.authorEmail ? doc.authorEmail : DEFAULT_GIT_OPTIONS.authorEmail,
        sslVerify: doc.sslVerify === false ? false : true,
        hostKeyPolicy: doc.hostKeyPolicy === "skip" ? "skip" : "tofu",
      }
    } catch {
      this.cache = { ...DEFAULT_GIT_OPTIONS }
    }
  }

  get(): GitOptions {
    return this.cache
  }

  async save(patch: Partial<GitOptions>): Promise<void> {
    this.cache = { ...this.cache, ...patch }
    await atomicWriteText(optionsPath(), JSON.stringify(this.cache))
  }
}

export const kGitOptions = lazyInit<GitOptionsStore>(() => new GitOptionsStore())
