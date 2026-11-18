/**
 * Global channel for problem notices (confirm dialog with a single OK button).
 * Failure / validation messages go here (validate failed, import/export/save failed, invalid name, ...);
 * success feedback stays on the toast channel (Paper Snackbar).
 */
import { proxy } from "valtio"

export const noticeState = proxy<{ visible: boolean; title: string; message: string; seq: number }>({
  visible: false,
  title: "",
  message: "",
  seq: 0,
})

export function showNotice(message: string, opts?: { title?: string }) {
  // Every problem notice is, by definition, a failure surfaced to the user - mirror it to the
  // Metro console so dialogs like "Git operation failed" leave a log record of their payloads.
  console.error(`[notice] ${opts?.title ?? "(no title)"}: ${message}`)
  noticeState.title = opts?.title ?? ""
  noticeState.message = message
  noticeState.seq++
  noticeState.visible = true
}

export function dismissNotice() {
  noticeState.visible = false
}
