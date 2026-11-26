import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

export interface Spec extends TurboModule {
  addListener(eventType: string): void
  removeListeners(count: number): void

  /** JSON: { id, title, body, projectId, convId } — resolves false when notifications are disabled for the app */
  postNotification(payload: string): Promise<boolean>
  cancelNotification(id: string): Promise<boolean>
  cancelAll(): Promise<boolean>
  areNotificationsEnabled(): Promise<boolean>

  /** true = this app is exempt from battery optimization (unrestricted background) */
  isIgnoringBatteryOptimizations(): Promise<boolean>
  /** Fires ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS; false = no handler (caller falls back to the settings list) */
  requestIgnoreBatteryOptimizations(): Promise<boolean>
  openBatteryOptimizationSettings(): Promise<boolean>

  /** Cold-start notification tap (from the launch intent); JSON { projectId, convId } or "" — clears on read */
  getInitialTap(): Promise<string>
}

/**
 * `get` (not getEnforcing) on purpose: a JS-only reload against an APK built before this module existed
 * boots normally and every notification helper becomes a no-op instead of crashing the app at startup.
 */
export const NativeAppNotify = TurboModuleRegistry.get<Spec>('AppNotify')