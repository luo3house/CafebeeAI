/**
 * App runtime preferences: theme mode + global default reasoning display mode + tool auto-approval + app-wide
 * font scale. Persisted (changed 2026-11-24, rule 31): hydrate `<appRoot>/app-settings.json` during kApp
 * bootstrap (loadAppSettingsSpec in core/app-settings.ts) and write the full snapshot back on every setter.
 * The old "in-memory only, reset to off on cold start" convention is retired — notably autoApproveWrites now
 * survives restarts (the one-time ConfirmDialog before ENABLE stays, rule 4); an `auto_approve_writes: true`
 * arriving via transfer applies directly (choosing to import IS the user's confirmation).
 * Theme: system (follow the OS: dark→dark / light→newsprint) | newsprint (warm off-white, the default) | light | dark.
 * Font scale: 1 = the built-in sizes (default); applied through the derived theme (see app.ui.theme.ts).
 */
import { proxy } from "valtio"
import { loadAppSettingsSpec, saveAppSettingsSpec, type AppSettingsSpec } from "../core/app-settings"

export type ThemeMode = "system" | "newsprint" | "light" | "dark"
export type ReasoningMode = "min" | "inline" | "scroll" | "full"

/** Discrete app-wide font scale presets (1 = the current built-in sizes). Keep in sync with the load-side list in core/app-settings.ts. */
export const FONT_SCALE_PRESETS = [0.9, 1, 1.1, 1.25] as const

export const settings = proxy<{
  themeMode: ThemeMode
  reasoningMode: ReasoningMode
  autoApproveWrites: boolean
  fontScale: number
}>({
  themeMode: "newsprint",
  reasoningMode: "min",
  autoApproveWrites: false,
  fontScale: 1,
})

/** Hydrated flag: setters never write the disk file before the first load finished (a write racing hydration could clobber it). */
let hydrated = false

/** Current values as a transfer spec (used by the `v1/app_settings` renderer and disk write-back). */
export function appSettingsSnapshot(): AppSettingsSpec {
  return {
    theme_mode: settings.themeMode,
    reasoning_mode: settings.reasoningMode,
    font_scale: settings.fontScale,
    auto_approve_writes: settings.autoApproveWrites,
  }
}

function persistSettings(): void {
  if (!hydrated) return
  // best-effort: setters stay synchronous for the UI; a failed write only costs persistence, never a crash
  void saveAppSettingsSpec(appSettingsSnapshot()).catch(() => {})
}

/**
 * kApp bootstrap: apply the disk snapshot to the proxy (defaults stand for absent keys). Called before the
 * hydrated flag flips, so hydration itself never triggers a write-back.
 */
export async function hydrateAppSettings(): Promise<void> {
  const spec = await loadAppSettingsSpec()
  if (spec) {
    if (spec.theme_mode !== undefined) settings.themeMode = spec.theme_mode
    if (spec.reasoning_mode !== undefined) settings.reasoningMode = spec.reasoning_mode
    if (spec.font_scale !== undefined) settings.fontScale = spec.font_scale
    if (spec.auto_approve_writes !== undefined) settings.autoApproveWrites = spec.auto_approve_writes
  }
  hydrated = true
}

/**
 * Transfer apply (rule 38 `v1/app_settings`): assigns only the keys the document carries (partial tolerance,
 * same philosophy as config.yaml rule 8). Every applied setter writes through to disk. Returns silently;
 * schema gating already happened in the transfer module.
 */
export function applyImportedAppSettings(spec: AppSettingsSpec): void {
  if (spec.theme_mode !== undefined) setThemeMode(spec.theme_mode)
  if (spec.reasoning_mode !== undefined) setReasoningMode(spec.reasoning_mode)
  if (spec.font_scale !== undefined) setFontScale(spec.font_scale)
  if (spec.auto_approve_writes !== undefined) setAutoApproveWrites(spec.auto_approve_writes)
}

export function setThemeMode(mode: ThemeMode) {
  settings.themeMode = mode
  persistSettings()
}

export function setReasoningMode(mode: ReasoningMode) {
  settings.reasoningMode = mode
  persistSettings()
}

export function setAutoApproveWrites(enabled: boolean) {
  settings.autoApproveWrites = enabled
  persistSettings()
}

export function setFontScale(scale: number) {
  settings.fontScale = scale
  persistSettings()
}
