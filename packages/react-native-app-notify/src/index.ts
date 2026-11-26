/**
 * JS facade over the AppNotify native module: notification posting/cancelling, notification-tap events
 * (warm via an event, cold start via getInitialTap) and the battery-optimization helpers.
 * Every helper degrades to a safe no-op when the native module is absent (old APK / JS-only reload).
 */
import { DeviceEventEmitter } from 'react-native'
import { NativeAppNotify } from './NativeAppNotify'

export { NativeAppNotify }

export interface NotificationPayload {
  /** Stable key: one notification per conversation (same id replaces the previous one) */
  id: string
  title: string
  body: string
  projectId: string
  convId: string
}

export interface NotificationTap {
  projectId: string
  convId: string
}

export const NOTIFICATION_TAP_EVENT = 'AppNotifyTap'

function parseTap(raw: unknown): NotificationTap | null {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!parsed || typeof parsed !== 'object') return null
    const projectId = (parsed as { projectId?: unknown }).projectId
    const convId = (parsed as { convId?: unknown }).convId
    if (typeof projectId !== 'string' || typeof convId !== 'string') return null
    return { projectId, convId }
  } catch {
    return null
  }
}

/** Warm notification tap (the app is alive): the native side emits one event per tap */
export function subscribeNotificationTap(listener: (tap: NotificationTap) => void): () => void {
  const sub = DeviceEventEmitter.addListener(NOTIFICATION_TAP_EVENT, (raw: unknown) => {
    const tap = parseTap(raw)
    if (tap) listener(tap)
  })
  return () => sub.remove()
}

export async function postNotification(payload: NotificationPayload): Promise<boolean> {
  if (!NativeAppNotify) return false
  try {
    return await NativeAppNotify.postNotification(JSON.stringify(payload))
  } catch {
    return false
  }
}

export async function cancelNotification(id: string): Promise<void> {
  if (!NativeAppNotify) return
  try {
    await NativeAppNotify.cancelNotification(id)
  } catch {
    // noop
  }
}

export async function cancelAll(): Promise<void> {
  if (!NativeAppNotify) return
  try {
    await NativeAppNotify.cancelAll()
  } catch {
    // noop
  }
}

export async function areNotificationsEnabled(): Promise<boolean> {
  if (!NativeAppNotify) return false
  try {
    return await NativeAppNotify.areNotificationsEnabled()
  } catch {
    return false
  }
}

export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  if (!NativeAppNotify) return false
  try {
    return await NativeAppNotify.isIgnoringBatteryOptimizations()
  } catch {
    return false
  }
}

export async function requestIgnoreBatteryOptimizations(): Promise<boolean> {
  if (!NativeAppNotify) return false
  try {
    return await NativeAppNotify.requestIgnoreBatteryOptimizations()
  } catch {
    return false
  }
}

export async function openBatteryOptimizationSettings(): Promise<boolean> {
  if (!NativeAppNotify) return false
  try {
    return await NativeAppNotify.openBatteryOptimizationSettings()
  } catch {
    return false
  }
}

/** Cold-start notification tap; clears the pending value on read */
export async function getInitialTap(): Promise<NotificationTap | null> {
  if (!NativeAppNotify) return null
  try {
    const raw = await NativeAppNotify.getInitialTap()
    return parseTap(raw)
  } catch {
    return null
  }
}