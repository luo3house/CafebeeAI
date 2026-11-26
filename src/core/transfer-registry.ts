/**
 * Transfer registry (rule 38 composition root): assembles the five kind modules into the engine's module map,
 * exposes per-surface stream renderers (single-kind pages and the Settings "Export all data" bundle) and binds
 * each page's accepted-kind set for file / text import.
 *
 * Backup stream order (frozen): providers -> git credentials -> system prompts -> skills -> app settings.
 * One `v1/app_settings` document is ALWAYS emitted (singleton); empty registries emit no documents of their
 * kind. `includeSecrets` (the export dialog checkbox, default OFF) switches the provider key / credential
 * password/token/private key/passphrase from `-- DEDUCTED --` placeholders to plaintext values; `public_key`
 * is plain text regardless. The staged backup file may therefore hold plaintext secrets until the 24h cache
 * sweep — the export dialog copy says so explicitly (share carefully).
 *
 * The v1/app_settings adapter lives here (not in a per-kind file): it's the only module whose "store" is the
 * valtio settings proxy + the disk snapshot in core/app-settings.ts; apply routes through state/settings so
 * every changed key lands via its persisting setter (rule 31). Multiple app_settings documents in one stream:
 * last one wins (documents apply in stream order).
 */
import {
  KIND_APP_SETTINGS,
  KIND_GIT_CREDENTIAL,
  KIND_PROVIDER,
  KIND_SKILL,
  KIND_SYSTEM_PROMPT,
  loadStream,
  importStreamText,
  renderStream,
  type KindAdapter,
  type LoadedStream,
  type TransferReport,
} from "./transfer"
import { AppSettingsSpecSchema, type AppSettingsSpec } from "./app-settings"
import { providerTransfer, renderProvidersYaml } from "./providers-transfer"
import { gitCredTransfer, renderGitCredsYaml } from "./git-cred-transfer"
import { promptTransfer, renderSystemPromptsYaml } from "./prompts-transfer"
import { skillTransfer, renderSkillsYaml } from "./skills-transfer"
import { applyImportedAppSettings, appSettingsSnapshot } from "../state/settings"

export { TransferAbortError } from "./transfer"
export type { TransferReport, LoadedStream, LoadedDoc, KindAdapter } from "./transfer"
export {
  DEDUCTED,
  KIND_APP_SETTINGS,
  KIND_GIT_CREDENTIAL,
  KIND_PROVIDER,
  KIND_SKILL,
  KIND_SYSTEM_PROMPT,
  ALL_KINDS,
  renderStream,
  stageTransferYaml,
  readTransferFile,
  isDeducted,
} from "./transfer"
export { PROVIDERS_DOC_KIND, renderProvidersYaml } from "./providers-transfer"
export { GIT_CRED_DOC_KIND, renderGitCredsYaml } from "./git-cred-transfer"
export { SYSTEM_PROMPT_DOC_KIND, renderSystemPromptsYaml } from "./prompts-transfer"
export { SKILL_DOC_KIND, renderSkillsYaml } from "./skills-transfer"

/** The engine's router table: every live kind maps to its validate/apply adapter. */
export const TRANSFER_MODULES: Record<string, KindAdapter> = {
  [KIND_PROVIDER]: { validate: providerTransfer },
  [KIND_GIT_CREDENTIAL]: { validate: gitCredTransfer },
  [KIND_SYSTEM_PROMPT]: { validate: promptTransfer },
  [KIND_SKILL]: { validate: skillTransfer },
  [KIND_APP_SETTINGS]: { validate: appSettingsTransfer },
}

function appSettingsTransfer(spec: unknown): { apply?: () => Promise<"created" | "updated">; message?: string } {
  const parsed = AppSettingsSpecSchema.safeParse(spec)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue?.path?.length ? ` at ${issue.path.join(".")}` : ""
    return { message: `invalid app_settings document${at}: ${issue?.message ?? "schema mismatch"}` }
  }
  const data = parsed.data as AppSettingsSpec
  // completion_notifications never counts as applicable: import never applies it (rule 39 - enabling
  // requires the interactive permission ask), so a document carrying only that key has nothing to apply.
  const applicableKeys = (["theme_mode", "reasoning_mode", "font_scale", "auto_approve_writes"] as const).filter(
    (k) => data[k] !== undefined
  )
  if (applicableKeys.length === 0) {
    return {
      message:
        data.completion_notifications !== undefined
          ? "spec carries only completion_notifications, which import never applies (enable notifications in Settings)"
          : "spec carries none of theme_mode / reasoning_mode / font_scale / auto_approve_writes",
    }
  }
  return {
    apply: async () => {
      applyImportedAppSettings(data)
      return "updated"
    },
  }
}

/** Settings-page stream: current on-disk values rendered as the one singleton document. */
export function renderAppSettingsYaml(): string {
  return renderStream([{ kind: KIND_APP_SETTINGS, spec: appSettingsSnapshot() }])
}

/** Full backup for a surface: `accepted` kinds only (per-kind pages pass one kind; Settings passes all five). */
export async function renderAcceptedYaml(accepted: readonly string[], includeSecrets: boolean): Promise<string> {
  const parts: string[] = []
  if (accepted.includes(KIND_PROVIDER)) parts.push(await renderProvidersYaml(includeSecrets))
  if (accepted.includes(KIND_GIT_CREDENTIAL)) parts.push(await renderGitCredsYaml(includeSecrets))
  if (accepted.includes(KIND_SYSTEM_PROMPT)) parts.push(renderSystemPromptsYaml())
  if (accepted.includes(KIND_SKILL)) parts.push(renderSkillsYaml())
  // app settings is a singleton emitted only by the full backup (accepted must name the kind): exactly one
  // doc; a stream carrying several applies in order (last one wins)
  if (accepted.includes(KIND_APP_SETTINGS)) parts.push(renderAppSettingsYaml())
  return parts.join("")
}

/** File-path import (the flow that reports): never throws for document-level problems (TransferAbortError for structural ones). */
export function importYamlFor(accepted: readonly string[], text: string): Promise<TransferReport> {
  const accept = (kind: string) => accepted.includes(kind)
  return importStreamText(text, accept, TRANSFER_MODULES)
}

/** Side-effect-free precheck for the TextEditor validate step (returns parsed docs for onSave). */
export function precheckYamlFor(accepted: readonly string[], text: string): LoadedStream {
  const accept = (kind: string) => accepted.includes(kind)
  return loadStream(text, accept, TRANSFER_MODULES)
}

/** Apply a precheck result (validate already accepted the kinds — same modules, same order). */
export async function applyLoaded(loaded: LoadedStream): Promise<TransferReport> {
  const report: TransferReport = { created: 0, updated: 0, skipped: loaded.skipped, errors: [...loaded.errors] }
  for (const doc of loaded.docs) {
    try {
      const outcome = await doc.apply()
      if (outcome === "created") report.created++
      else report.updated++
    } catch (err: any) {
      report.errors.push(`document #${doc.index + 1} (${doc.kind}): ${String(err?.message ?? err)}`)
    }
  }
  return report
}
