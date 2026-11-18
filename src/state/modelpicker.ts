/**
 * Model/Provider selection coordinator (valtio).
 * When a send lacks a provider / a model, it suspends and resolves after navigating to the dedicated ModelPicker page.
 * The navigation action is registered from outside (`bindModelPickerNavigator`) to avoid a state → navigator → screen module cycle.
 */
import { proxy } from "valtio"
import type { LLMProvider } from "../core/providers"

let navigateToPicker: (() => boolean) | null = null

/** Registered by app.ui.navigator: takes the user to the full-screen ModelPicker page; returns false when navigation is not possible */
export function bindModelPickerNavigator(fn: () => boolean): void {
  navigateToPicker = fn
}

export interface ModelPickerState {
  visible: boolean
  purpose: "beforeSend" | "manual" | null
  provider: LLMProvider | null
  requireProvider: boolean
  modelNames: string[]
  fetching: boolean
  fetchError: string | null
  manualInput: string
  resolveFn: ((value: string | null) => void) | null
}

export const modelPicker = proxy<ModelPickerState>({
  visible: false,
  purpose: null,
  provider: null,
  requireProvider: false,
  modelNames: [],
  fetching: false,
  fetchError: null,
  manualInput: "",
  resolveFn: null,
})

/** Open the picker page (the Root Stack's full-screen ModelPicker page); resolve(value|null). A null value means cancelled. */
export function openModelPicker(opts: {
  purpose: "beforeSend" | "manual"
  provider?: LLMProvider | null
  modelNames?: string[]
  requireProvider?: boolean
}): Promise<string | null> {
  return new Promise((resolve) => {
    const wasVisible = modelPicker.visible
    modelPicker.purpose = opts.purpose
    modelPicker.provider = opts.provider ?? null
    modelPicker.modelNames = opts.modelNames ?? []
    modelPicker.requireProvider = opts.requireProvider ?? false
    modelPicker.fetching = false
    modelPicker.fetchError = null
    modelPicker.manualInput = ""
    modelPicker.resolveFn = resolve
    modelPicker.visible = true
    if (!wasVisible && !navigateToPicker?.()) closeModelPicker(null)
  })
}

export function closeModelPicker(value: string | null): void {
  const fn = modelPicker.resolveFn
  modelPicker.visible = false
  modelPicker.resolveFn = null
  modelPicker.purpose = null
  fn?.(value)
}

/** Let the UI know: a provider also needs choosing (the linkage when requireProvider=true) */
export function setPickerProvider(provider: LLMProvider | null) {
  modelPicker.provider = provider
}