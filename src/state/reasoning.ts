/**
 * Full reasoning viewer (standalone full-page mode): the route only opens the page; content goes through in-memory state.
 */
import { proxy } from "valtio"

export const reasoningViewer = proxy<{
  text: string
  title: string
}>({
  text: "",
  title: "Reasoning",
})

export function openReasoningViewer(text: string, title?: string) {
  reasoningViewer.text = text
  reasoningViewer.title = title ?? "Reasoning"
}