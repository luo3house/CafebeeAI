/**
 * Completion notifications (opt-in, background-only) + battery-optimization helpers.
 * - Notify only while the app is NOT active; states: turn done / turn failed / waiting on a human
 *   (pending write confirmation or form). User-stop is a foreground action and never notifies.
 * - One notification per conversation (payload id = convId): later events replace earlier ones.
 * - Opt-in: settings.completionNotifications (default off, persisted in app-settings.json). Every post is
 *   additionally gated natively by NotificationManager.areNotificationsEnabled() (POST_NOTIFICATIONS).
 * - Notification text: title = project display name, body = "<conversation name> · <status word>".
 * This module must not import state/chat (chat imports it for the visible/delete cancels).
 */
import { AppState } from "react-native"
import {
  areNotificationsEnabled,
  cancelAll,
  cancelNotification,
  getInitialTap,
  isIgnoringBatteryOptimizations,
  openBatteryOptimizationSettings,
  postNotification,
  requestIgnoreBatteryOptimizations,
  subscribeNotificationTap,
  type NotificationTap,
} from "react-native-app-notify"
import { listProjects } from "../core/projects"
import { kChatStore } from "../core/chats"
import { runtime } from "./runtime"
import { settings } from "./settings"

export type NotificationKind = "done" | "error" | "attention"

const STATUS_WORD: Record<NotificationKind, string> = {
  done: "Reply complete",
  error: "Failed",
  attention: "Needs attention",
}

const UNTITLED_CONVERSATION = "Untitled conversation"

function appInBackground(): boolean {
  return AppState.currentState !== "active"
}

async function postSessionNotification(projectId: string, convId: string, kind: NotificationKind): Promise<void> {
  try {
    // list() (not get()): get() persists sanitize repairs, which would corrupt a conversation whose turn is
    // still streaming (the pending-confirmation path notifies mid-turn); list() is read-only.
    const [projects, briefs] = await Promise.all([
      listProjects().catch(() => []),
      kChatStore()
        .list(projectId)
        .catch(() => []),
    ])
    const projectName = projects.find((p) => p.id === projectId)?.displayName ?? "Default"
    const conversationName =
      briefs.find((b) => b.conversation.id === convId)?.conversation.title?.trim() || UNTITLED_CONVERSATION
    await postNotification({
      id: convId,
      title: projectName,
      body: `${conversationName} · ${STATUS_WORD[kind]}`,
      projectId,
      convId,
    })
  } catch {
    // A notification failure must never touch the turn
  }
}

/** Turn wrap-up (done/error) while the app is in the background */
export function notifyTurnFinished(projectId: string, convId: string, kind: "done" | "error"): void {
  if (!settings.completionNotifications) return
  if (!appInBackground()) return
  void postSessionNotification(projectId, convId, kind)
}

/** A tool card / form started waiting on the user while the app is in the background */
export function notifyHumanWait(projectId: string, convId: string): void {
  if (!settings.completionNotifications) return
  if (!appInBackground()) return
  void postSessionNotification(projectId, convId, "attention")
}

export function cancelConversationNotification(convId: string): void {
  void cancelNotification(convId)
}

export function cancelAllNotifications(): void {
  void cancelAll()
}

/** The bound conversation is on screen → its notification is stale (cancel on bind / foreground / focus) */
export function syncVisibleConversation(): void {
  if (AppState.currentState !== "active") return
  const convId = runtime.currentConversationId
  if (convId) cancelConversationNotification(convId)
}

/** Cold-start notification tap (launch intent extras); clears the pending value on read */
export function consumeInitialNotificationTap(): Promise<NotificationTap | null> {
  return getInitialTap()
}

/** Warm notification taps (app alive) */
export function onNotificationTap(listener: (tap: NotificationTap) => void): () => void {
  return subscribeNotificationTap(listener)
}

/** Debug page helper: bypasses the opt-in switch and the background gate */
export async function postDebugNotification(kind: NotificationKind): Promise<boolean> {
  return postNotification({
    id: "debug-notification",
    title: "Test Project",
    body: `Test conversation · ${STATUS_WORD[kind]}`,
    projectId: runtime.currentProjectId,
    convId: "debug-conversation",
  })
}

/** true = the app is exempt from battery optimization (unrestricted background) */
export function isBatteryOptimizationIgnored(): Promise<boolean> {
  return isIgnoringBatteryOptimizations()
}

/** Direct "allow always running in background" request; false = no handler (fall back to the settings list) */
export function requestBatteryOptimizationExemption(): Promise<boolean> {
  return requestIgnoreBatteryOptimizations()
}

export function openBatterySettings(): Promise<boolean> {
  return openBatteryOptimizationSettings()
}

/** Whether the OS currently allows this app to post notifications (used by the Settings switch flow) */
export function notificationsAllowed(): Promise<boolean> {
  return areNotificationsEnabled()
}