/**
 * Runtime global state: current Project / current conversation / cached project and conversation lists.
 */
import { proxy } from "valtio"
import { DEFAULT_PROJECT_ID } from "../core/uuid"
import type { ProjectMeta } from "../core/projects"
import type { Conversation } from "../core/chats"

export const runtime = proxy<{
  currentProjectId: string
  currentConversationId: string | null
  projects: ProjectMeta[]
  conversations: Conversation[]
}>({
  currentProjectId: DEFAULT_PROJECT_ID,
  currentConversationId: null,
  projects: [],
  conversations: [],
})

export function setCurrentProjectId(id: string) {
  runtime.currentProjectId = id
  runtime.currentConversationId = null
}

export function setProjects(list: ProjectMeta[]) {
  runtime.projects = list
  if (!runtime.projects.some((p) => p.id === runtime.currentProjectId)) {
    // The current project is gone → fall back to the default project
    runtime.currentProjectId = DEFAULT_PROJECT_ID
    runtime.currentConversationId = null
  }
}

export function setConversations(list: Conversation[]) {
  runtime.conversations = list
  if (runtime.currentConversationId && !list.some((c) => c.id === runtime.currentConversationId)) {
    runtime.currentConversationId = null
  }
}