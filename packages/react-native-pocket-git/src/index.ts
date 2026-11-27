import { NativeEventEmitter } from 'react-native'
import { NativePocketGit } from './NativePocketGit'

export type GitCredential =
  | { type: 'none' }
  | { type: 'userpass'; username: string; password: string }
  | { type: 'sshKey'; username?: string; privatePem: string; passphrase?: string }

export type TransportOptions = {
  credential?: GitCredential
  sslVerify?: boolean
  hostKeyPolicy?: 'tofu' | 'skip'
  knownHostsPath?: string
}

export type GeneratedKey = {
  type: 'ed25519' | 'rsa'
  privatePem: string
  publicLine: string
  fingerprint: string
}

export type GitStatus = {
  hasHead: boolean
  branch: string
  clean: boolean
  changed: number
  unmerged: string[]
  modified: string[]
  staged: string[]
  added: string[]
  untracked: string[]
  removed: string[]
  missing: string[]
}

export type BranchInfo = { name: string; sha: string }

export type UploadResult = {
  committed: boolean
  commitSha?: string
  pushed: boolean
  reason?: string
}

export type SyncResult = { updated: boolean; branch: string; commitSha?: string; reason?: string }

export type CloneResult = { path: string; branch: string }

export type UploadParams = {
  handle: string
  message: string
  branch: string
  authorName?: string
  authorEmail?: string
  remoteUrl?: string
  force?: boolean
} & TransportOptions

export type SyncParams = {
  handle: string
  branch: string
  remoteUrl?: string
} & TransportOptions

export type CloneParams = {
  url: string
  targetPath: string
  branch?: string
  /** Project-config segment the clone target may already contain (empty = none) */
  reservedSegment?: string
} & TransportOptions

export type LsRemoteParams = {
  url: string
} & TransportOptions

export class GitOpError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'GitOpError'
    this.code = code
  }
}

/** Dump every git failure to the Metro console as-is; never log payloads (they carry credentials). */
function logOpFailure(context: string, err: unknown): void {
  console.error(`[pocket-git] ${context} failed`, err)
}

function logged<A>(context: string, p: Promise<A>): Promise<A> {
  return p.catch((err) => {
    logOpFailure(context, err)
    throw err
  })
}

type PendingOp = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onProgress?: (message: string) => void
}

const pending = new Map<string, PendingOp>()
let emitter: NativeEventEmitter | null = null

function ensureEventBridge(): void {
  if (emitter) return
  emitter = new NativeEventEmitter(NativePocketGit)
  emitter.addListener('PocketGitProgress', (e: { opId: string; message: string }) => {
    pending.get(e.opId)?.onProgress?.(e.message)
  })
  emitter.addListener('PocketGitDone', (e: { opId: string; result: string }) => {
    const op = pending.get(e.opId)
    if (!op) {
      console.error('[pocket-git] PocketGitDone for unknown opId (already settled?)', e)
      return
    }
    pending.delete(e.opId)
    try {
      op.resolve(e.result ? JSON.parse(e.result) : null)
    } catch (err) {
      console.error('[pocket-git] PocketGitDone result JSON.parse failed, resolving null', e.opId, err)
      op.resolve(null)
    }
  })
  emitter.addListener('PocketGitFailed', (e: { opId: string; code: string; message: string }) => {
    console.error('[pocket-git] PocketGitFailed event', e)
    const op = pending.get(e.opId)
    if (!op) {
      console.error('[pocket-git] PocketGitFailed for unknown opId (already settled?)', e)
      return
    }
    pending.delete(e.opId)
    op.reject(new GitOpError(e.code ?? 'git_error', e.message ?? 'Git operation failed'))
  })
}

function unwrap<T>(json: string): T {
  return (json ? JSON.parse(json) : null) as T
}

export async function ensureRepo(path: string, initialBranch = 'main', reservedSegment = ''): Promise<string> {
  return unwrap<{ handle: string }>(
    await logged('ensureRepo', NativePocketGit.ensureRepo(path, initialBranch, reservedSegment)),
  ).handle
}

/** Create a bare repository (local push target for the offline demo fixture). */
export async function initBareRepo(path: string): Promise<void> {
  await logged('initBareRepo', NativePocketGit.initBare(path))
}

export async function close(handle: string): Promise<void> {
  await logged('close', NativePocketGit.close(handle))
}

export async function status(handle: string): Promise<GitStatus> {
  return unwrap<GitStatus>(await logged('status', NativePocketGit.status(handle)))
}

export async function setRemote(handle: string, url: string, name = 'origin'): Promise<void> {
  await logged('setRemote', NativePocketGit.setRemote(handle, name, url))
}

export async function getRemote(handle: string, name = 'origin'): Promise<string | null> {
  const r = unwrap<{ url: string | null }>(await logged('getRemote', NativePocketGit.getRemote(handle, name)))
  return r.url
}

export async function lsRemote(params: LsRemoteParams): Promise<BranchInfo[]> {
  return unwrap<{ branches: BranchInfo[] }>(
    await logged('lsRemote', NativePocketGit.lsRemote(JSON.stringify(params))),
  ).branches
}

export async function generateSshKey(params?: {
  type?: 'ed25519' | 'rsa'
  bits?: number
  comment?: string
}): Promise<GeneratedKey> {
  return unwrap<GeneratedKey>(
    await logged('generateSshKey', NativePocketGit.generateSshKey(JSON.stringify(params ?? {}))),
  )
}

function startLongOp<A>(
  label: string,
  start: () => Promise<string>,
  onProgress?: (message: string) => void,
): { promise: Promise<A>; cancel: () => Promise<void> } {
  let opId = ''
  const promise = (async () => {
    ensureEventBridge()
    try {
      opId = await start()
    } catch (err) {
      logOpFailure(`${label} opId=not-started`, err)
      throw err
    }
    try {
      return (await new Promise<A>((resolve, reject) => {
        pending.set(opId, { resolve: resolve as (v: unknown) => void, reject, onProgress })
      })) as A
    } catch (err) {
      logOpFailure(`${label} opId=${opId}`, err)
      throw err
    }
  })()
  return { promise, cancel: async () => { if (opId) await NativePocketGit.cancel(opId) } }
}

export function clone(
  params: CloneParams,
  onProgress?: (message: string) => void,
): { promise: Promise<CloneResult>; cancel: () => Promise<void> } {
  return startLongOp<CloneResult>('clone', () => NativePocketGit.cloneStart(JSON.stringify(params)), onProgress)
}

export function upload(
  params: UploadParams,
  onProgress?: (message: string) => void,
): { promise: Promise<UploadResult>; cancel: () => Promise<void> } {
  return startLongOp<UploadResult>('upload', () => NativePocketGit.uploadStart(JSON.stringify(params)), onProgress)
}

export function sync(
  params: SyncParams,
  onProgress?: (message: string) => void,
): { promise: Promise<SyncResult>; cancel: () => Promise<void> } {
  return startLongOp<SyncResult>('sync', () => NativePocketGit.syncStart(JSON.stringify(params)), onProgress)
}

export function forceSync(
  params: SyncParams,
  onProgress?: (message: string) => void,
): { promise: Promise<SyncResult>; cancel: () => Promise<void> } {
  return startLongOp<SyncResult>('forceSync', () => NativePocketGit.forceSyncStart(JSON.stringify(params)), onProgress)
}

export type { Spec } from './NativePocketGit'
