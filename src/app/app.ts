/**
 * App singleton and bootstrap: app-level singleton; lazyInit triggers bootstrap only on first use.
 */
import { AppState } from "react-native"
import { lazyInit } from "../core/lazy"
import { ensureBootstrap } from "../core/projects"
import { kProviderRegistry } from "../core/providers"
import { kSecretStore } from "../core/secrets"
import { kGitApp } from "../core/git"
import { kSystemPromptStore } from "../core/system-prompts"
import { kSkillStore } from "../core/skills"
import { sweepShareCache } from "../core/import-export"
import { runProjectSweepIfDue } from "../core/project-sweeper"
import { flushAllSessions } from "../state/chat"

class App {
  ready: Promise<void>

  constructor() {
    // Fallback inside bootstrap: ready never rejects, so kApp().ready.then(...) cannot bubble up as Uncaught (in promise)
    this.ready = this.bootstrap().catch((err) => {
      console.warn("bootstrap failed", err)
    })
    // Force flush on backgrounding: backstop for the 800ms message debounce + draft/read-state persistence (turns themselves are not interrupted by backgrounding, R1-Q4)
    AppState.addEventListener("change", (state) => {
      if (state !== "active") void flushAllSessions()
    })
  }

  private async bootstrap(): Promise<void> {
    await Promise.all([
      ensureBootstrap(),
      kProviderRegistry().load(),
      kSecretStore().load(),
      kGitApp().load(),
      kSystemPromptStore().load(),
      kSkillStore().load(),
    ])
    // Periodic stale-cache cleanup (24h TTL): fire-and-forget, export/open staging is never blocking startup.
    sweepShareCache().catch(() => {})
    // Orphan project-state sweeper (14-day window, startup async): never blocks startup.
    runProjectSweepIfDue().catch(() => {})
  }
}

export const kApp = lazyInit<App>(() => new App())
