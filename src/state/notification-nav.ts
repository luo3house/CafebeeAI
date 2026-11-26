/**
 * Notification-tap navigation (reverse-bound navigator, same trick as state/modelpicker: this module must not
 * import app.ui.navigator — navigator -> chat.screen -> this -> navigator would cycle at module load).
 * Cold start: ChatScreen consumes the initial tap before its normal landing binding.
 * Warm tap: an event arrives; we bind the target (explicit entry → markRead) and pop to the chat page.
 */
import { listProjects } from "../core/projects"
import { kChatStore } from "../core/chats"
import type { NotificationTap } from "react-native-app-notify"
import { runtime } from "./runtime"
import { bindConversation } from "./chat"

let navigateToChat: (() => void) | null = null

/** Registered by app.ui.navigator.tsx at module load */
export function bindNotificationNavigator(fn: () => void): void {
  navigateToChat = fn
}

/**
 * Open the notification's project + conversation. A deleted project/conversation degrades to the normal
 * landing (the chat screen's own binding effect picks a valid target) — never an error dialog.
 */
export async function openNotificationTarget(tap: NotificationTap): Promise<void> {
  try {
    const projects = await listProjects()
    runtime.projects = projects
    if (projects.some((p) => p.id === tap.projectId)) {
      const briefs = await kChatStore().list(tap.projectId)
      runtime.currentProjectId = tap.projectId
      runtime.conversations = briefs.map((b) => b.conversation)
      if (briefs.some((b) => b.conversation.id === tap.convId)) {
        // Tapping a notification IS explicit entry: mark read
        await bindConversation(tap.projectId, tap.convId, { markRead: true })
      } else {
        // Deleted conversation: let the chat screen land on the project's first (or a fresh) conversation
        runtime.currentConversationId = null
      }
    }
  } catch {
    // Degrade to the normal landing
  }
  navigateToChat?.()
}