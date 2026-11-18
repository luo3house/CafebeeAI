/**
 * App runtime preferences: theme mode + global default reasoning display mode + tool auto-approval + app-wide font scale (not persisted to disk, lives within the app session).
 * Theme: system (follow the OS: dark→dark / light→newsprint) | newsprint (warm off-white, the default) | light | dark.
 * Auto-approve: when enabled, write_file / edit_file / download_file execute silently (including regenerate replays); resets to off on cold start (dev-phase convention).
 * Font scale: 1 = the built-in sizes (default); applied through the derived theme (see app.ui.theme.ts); resets on cold start like the other in-memory settings.
 */
import { proxy } from "valtio"

export type ThemeMode = "system" | "newsprint" | "light" | "dark"
export type ReasoningMode = "min" | "inline" | "scroll" | "full"

/** Discrete app-wide font scale presets (1 = the current built-in sizes). */
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

export function setThemeMode(mode: ThemeMode) {
  settings.themeMode = mode
}

export function setReasoningMode(mode: ReasoningMode) {
  settings.reasoningMode = mode
}

export function setAutoApproveWrites(enabled: boolean) {
  settings.autoApproveWrites = enabled
}

export function setFontScale(scale: number) {
  settings.fontScale = scale
}
