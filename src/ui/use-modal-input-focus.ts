/**
 * Delayed auto-focus for input fields inside Modal/Dialog: wait 300ms after becoming visible (entry animation + Portal mount complete) before focus,
 * because focusing too early fails on some Android devices or clashes with the keyboard and the animation.
 */
import { useEffect, useRef } from "react"
import type { TextInput as NativeTextInput } from "react-native"

type PaperTextInputHandles = Pick<NativeTextInput, "focus" | "clear" | "blur" | "isFocused" | "setNativeProps" | "setSelection">

export function useModalInputFocus(active: boolean, delayMs = 300) {
  const ref = useRef<NativeTextInput & PaperTextInputHandles>(null)
  useEffect(() => {
    if (!active) return
    const timer = setTimeout(() => {
      ref.current?.focus()
    }, delayMs)
    return () => clearTimeout(timer)
  }, [active, delayMs])
  return ref
}
