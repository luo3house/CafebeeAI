import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

export interface Spec extends TurboModule {
  addListener(eventType: string): void
  removeListeners(count: number): void

  ensureRepo(path: string, initialBranch: string, reservedSegment: string): Promise<string>
  initBare(path: string): Promise<string>
  close(handle: string): Promise<string>
  status(handle: string): Promise<string>
  setRemote(handle: string, name: string, url: string): Promise<string>
  getRemote(handle: string, name: string): Promise<string>
  lsRemote(payload: string): Promise<string>

  cloneStart(payload: string): Promise<string>
  uploadStart(payload: string): Promise<string>
  syncStart(payload: string): Promise<string>
  forceSyncStart(payload: string): Promise<string>

  cancel(opId: string): Promise<string>

  generateSshKey(payload: string): Promise<string>
}

export const NativePocketGit =
  TurboModuleRegistry.getEnforcing<Spec>('PocketGit')
