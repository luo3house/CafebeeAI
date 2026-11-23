/**
 * Generic full-screen text editor contract (pure types, importable from navigator/screens/callers without cycles).
 * Route params carry the callbacks: the editor never interprets the text itself.
 */
export type TextEditorValidation = { ok: true; value?: unknown } | { ok: false; message?: string }

export interface TextEditorParams {
  /** PageHeader title */
  label: string
  initialText?: string
  /**
   * Read-only view: the header save button disappears, the TextInput is non-editable (text stays selectable),
   * and onSave is never called - omit it. Used by the built-in Ask / Code prompt rows (rule 35).
   */
  readOnly?: boolean
  /**
   * Async pre-check triggered by the header save button. Defaults to "fully pass" (value = raw text)
   * when omitted. Not ok -> the message surfaces as a problem-notice confirm dialog and the editor stays open.
   */
  validate?: (text: string) => Promise<TextEditorValidation>
  /**
   * Called only after validate() returned ok, with the validate result value (raw text when no validate
   * given). Await it; throwing shows a problem-notice confirm dialog and keeps the editor open; resolving closes it (goBack).
   */
  onSave?: (value: unknown, text: string) => Promise<void>
}
