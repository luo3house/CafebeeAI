/**
 * Full answer viewer ("Expand answer" full page): the route only opens the page; content goes through in-memory state.
 */
import { proxy } from "valtio"

export const answerViewer = proxy<{
  markdown: string
  title: string
}>({
  markdown: "",
  title: "Answer",
})

export function openAnswerViewer(markdown: string, title?: string) {
  answerViewer.markdown = markdown
  answerViewer.title = title ?? "Answer"
}
