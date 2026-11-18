/**
 * Global channel for light toasts (Paper Snackbar).
 */
import { proxy } from "valtio"

export const toastState = proxy<{ message: string; visible: boolean; seq: number }>({
  message: "",
  visible: false,
  seq: 0,
})

let timer: ReturnType<typeof setTimeout> | null = null

export function showToast(message: string) {
  if (timer) clearTimeout(timer)
  toastState.message = message
  toastState.seq++
  toastState.visible = true
  timer = setTimeout(() => {
    toastState.visible = false
  }, 2200)
}

export function dismissToast() {
  if (timer) clearTimeout(timer)
  toastState.visible = false
}