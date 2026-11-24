/**
 * Persistent app settings store (rule 31, flip 2026-11-24): the runtime preferences surfaced on the Settings
 * page — theme mode, default reasoning display mode, font size scale, auto-approve writes — now survive
 * restarts in `<appRoot>/app-settings.json`. The in-memory-only / cold-start-reset convention that came with
 * the rule-31 fontScale rollout was dropped by request ("顺手把 app settings 也做持久化"): state/settings.ts
 * hydrates this file during `kApp` bootstrap (before the first paint of theme-dependent UI) and every setter
 * writes the full snapshot back. The one-time ConfirmDialog before enabling auto-approve STAYS (rule 4) — only
 * the cold-start reset is gone; import applies it directly (choosing to import a backup IS the confirmation).
 *
 * The JSON shape mirrors the `v1/app_settings` transfer document 1:1 (`{ kind, spec }`), so the same zod spec
 * (AppSettingsSpecSchema) gates disk load AND import validation, and the on-disk file is itself a valid
 * single-document stream. Load tolerance: missing / corrupt / structurally-wrong = null (defaults stand);
 * unknown spec keys are stripped, missing keys stay default (partial parse, same philosophy as rule 8 config).
 */
import { z } from "zod"
import { appRootPath, atomicWriteText, exists, joinPath, readText } from "./fs"
import { KIND_APP_SETTINGS } from "./transfer"

const THEME_MODES = ["system", "newsprint", "light", "dark"] as const
const REASONING_MODES = ["min", "inline", "scroll", "full"] as const

/** Must stay in sync with FONT_SCALE_PRESETS in state/settings.ts (imported there, asserted equal below via type). */
const FONT_SCALE_PRESETS_LOCAL = [0.9, 1, 1.1, 1.25] as const

export const APP_SETTINGS_DOC_KIND = KIND_APP_SETTINGS

export const AppSettingsSpecSchema = z.object({
  theme_mode: z.enum(THEME_MODES).optional(),
  reasoning_mode: z.enum(REASONING_MODES).optional(),
  font_scale: z
    .number()
    .refine((v) => (FONT_SCALE_PRESETS_LOCAL as readonly number[]).includes(v), "font_scale must be one of 0.9, 1, 1.1, 1.25")
    .optional(),
  auto_approve_writes: z.boolean().optional(),
})

export type AppSettingsSpec = z.infer<typeof AppSettingsSpecSchema>

function appSettingsPath(): string {
  return joinPath(appRootPath(), "app-settings.json")
}

/** Read the disk snapshot as a transfer spec (any problem -> null, defaults stand; never throws). */
export async function loadAppSettingsSpec(): Promise<AppSettingsSpec | null> {
  try {
    if (!(await exists(appSettingsPath()))) return null
    const raw = JSON.parse(await readText(appSettingsPath())) as { spec?: unknown }
    const parsed = AppSettingsSpecSchema.safeParse(raw?.spec)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Write the full snapshot atomically (callers serialize via atomicWriteText's per-path queue). */
export async function saveAppSettingsSpec(spec: AppSettingsSpec): Promise<void> {
  await atomicWriteText(appSettingsPath(), JSON.stringify({ kind: APP_SETTINGS_DOC_KIND, spec }, null, 2))
}
