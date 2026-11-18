/**
 * Constants and app info.
 */
export const APP_NAME = "CafebeeAI"
export const APP_VERSION = "0.1.0"
export const APP_BUILD_LABEL = `v${APP_VERSION}`

export const MAX_ATTACHMENT_CHARS = 32 * 1024

export const TEXT_MARKER = {
  attachment: "[Attachment]",
}

/** Reasoning display modes (used on the settings page) */
export const REASONING_MODES: { key: "inline" | "scroll" | "full"; label: string }[] = [
  { key: "inline", label: "Expand all" },
  { key: "scroll", label: "Scroll" },
  { key: "full", label: "Full page" },
]