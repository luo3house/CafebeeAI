/**
 * Git orchestration facade for the app: binds the react-native-pocket-git SDK to Project workspaces.
 * - One native repo handle per project, lazily ensured on the first upload/sync (rule: no .git until first use;
 *   clone creates the repo natively).
 * - Project binding (branch / credential id / remote url) lives in `project-meta/<id>/config.yaml` git segment;
 *   credentials resolve through EncryptedStorage (rule 29), options through git-options.json.
 * - A Project directory is pure user files, so no .gitignore seeding is needed (`.cafebeeai` never lives there).
 * - Busy/progress state mirrors into gitState so dialogs can render and cancel; the SDK op itself is never
 *   retried here (user-driven actions, en-US error codes carried through).
 */
import {
  ensureRepo,
  close as closeRepo,
  upload as sdkUpload,
  sync as sdkSync,
  forceSync as sdkForceSync,
  clone as sdkClone,
  lsRemote as sdkLsRemote,
  GitOpError,
  type BranchInfo,
  type SyncResult,
  type UploadResult,
} from "react-native-pocket-git"
import { projectRoot } from "./projects"
import { loadConfig, setPreferences, type GitSpec } from "./config"
import { kGitCredentialStore } from "./git-credentials"
import { kGitOptions, gitKnownHostsPath, DEFAULT_GIT_OPTIONS } from "./git-options"
import { projectGit } from "../state/git"
import { lazyInit } from "./lazy"

const handles = new Map<string, string>()
const cancelFns = new Map<string, () => Promise<void>>()

/** Log every git facade failure verbatim before rethrowing; never include payloads/secrets. */
function logGitFailure(context: string, projectId: string, err: unknown): void {
  console.error(`[git:${context}] project=${projectId} failed`, err)
}


export interface GitSetup {
  branch?: string
  credId?: string
  remoteUrl?: string
}

export class GitBusyError extends Error {
  constructor() {
    super("Another git operation is already running for this project.")
  }
}

async function ensureHandle(projectId: string, branchHint?: string): Promise<string> {
  const existing = handles.get(projectId)
  if (existing) return existing
  const cfg = await loadConfig(projectId)
  const branch = branchHint || cfg.spec.git?.branch || "main"
  const handle = await ensureRepo(projectRoot(projectId), branch)
  handles.set(projectId, handle)
  return handle
}

export function releaseGitHandle(projectId: string): void {
  const h = handles.get(projectId)
  if (!h) return
  handles.delete(projectId)
  void closeRepo(h).catch(() => 0)
}

async function transportFields(credId?: string | null) {
  const opts = kGitOptions().get()
  const credential = await kGitCredentialStore().buildPayload(credId ?? null)
  return {
    credential,
    sslVerify: opts.sslVerify,
    hostKeyPolicy: opts.hostKeyPolicy,
    knownHostsPath: gitKnownHostsPath(),
  }
}

export async function getSetup(projectId: string): Promise<GitSetup> {
  const cfg = await loadConfig(projectId)
  const g = cfg.spec.git
  return { branch: g?.branch, credId: g?.cred_id, remoteUrl: g?.remote_url }
}

export async function saveSetup(projectId: string, part: Partial<GitSetup>): Promise<void> {
  const cfg = await loadConfig(projectId)
  const git: GitSpec = { ...cfg.spec.git }
  if (part.branch !== undefined) git.branch = part.branch
  if (part.credId !== undefined) git.cred_id = part.credId
  if (part.remoteUrl !== undefined) git.remote_url = part.remoteUrl
  setPreferences(projectId, { git })
}

export async function isGitConfigured(projectId: string): Promise<boolean> {
  const setup = await getSetup(projectId)
  return !!setup.remoteUrl
}

const EMBEDDED_CREDENTIALS_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/@]+@/i
const REMOTE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\/|^[^/@\s]+@[^/@\s]+:/i

/** Returns an en-US problem message, or null when the URL is acceptable (https/ssh, no embedded credentials). */
export function validateRemoteUrl(url: string): string | null {
  if (!url) return "Enter a repository URL."
  if (!REMOTE_URL_RE.test(url)) return "Enter a valid repository URL (https://… or git@host:…)."
  if (EMBEDDED_CREDENTIALS_RE.test(url)) {
    return "URLs with embedded credentials are not supported. Remove the user info and pick a credential instead."
  }
  return null
}

function guardBusy(projectId: string, kind: "upload" | "sync" | "clone"): ReturnType<typeof projectGit> {
  const st = projectGit(projectId)
  if (st.busy) throw new GitBusyError()
  st.busy = true
  st.kind = kind
  st.progress = "Starting"
  return st
}

function endBusy(st: ReturnType<typeof projectGit>): void {
  st.busy = false
  st.kind = null
  st.progress = ""
}

export async function runUpload(
  projectId: string,
  args: { message: string; branch: string; force?: boolean },
): Promise<UploadResult> {
  const st = guardBusy(projectId, "upload")
  try {
    const handle = await ensureHandle(projectId, args.branch)
    const setup = await getSetup(projectId)
    const opts = kGitOptions().get()
    const transport = await transportFields(setup.credId)
    const op = sdkUpload(
      {
        handle,
        message: args.message,
        branch: args.branch,
        authorName: opts.authorName || DEFAULT_GIT_OPTIONS.authorName,
        authorEmail: opts.authorEmail || DEFAULT_GIT_OPTIONS.authorEmail,
        remoteUrl: setup.remoteUrl ?? "",
        force: args.force ?? false,
        ...transport,
      },
      (m) => {
        st.progress = m
      },
    )
    cancelFns.set(projectId, op.cancel)
    const result = await op.promise
    await saveSetup(projectId, { branch: args.branch })
    return result
  } catch (err) {
    logGitFailure("upload", projectId, err)
    throw err
  } finally {
    cancelFns.delete(projectId)
    endBusy(st)
  }
}

/** Sync = fetch + fast-forward only; conflicts surface as GitOpError("sync_conflict") for the force dialog. */
export async function runSync(
  projectId: string,
  args: { branch: string; force?: boolean },
): Promise<SyncResult> {
  const st = guardBusy(projectId, "sync")
  try {
    const handle = await ensureHandle(projectId, args.branch)
    const setup = await getSetup(projectId)
    const transport = await transportFields(setup.credId)
    if (!setup.remoteUrl) {
      throw new GitOpError("no_remote", "No remote repository is set up for this project. Open Git settings first.")
    }
    const params = {
      handle,
      branch: args.branch,
      remoteUrl: setup.remoteUrl,
      ...transport,
    }
    const op = args.force ? sdkForceSync(params, (m) => { st.progress = m }) : sdkSync(params, (m) => { st.progress = m })
    cancelFns.set(projectId, op.cancel)
    const result = await op.promise
    await saveSetup(projectId, { branch: args.branch })
    return result
  } catch (err) {
    logGitFailure(args.force ? "forceSync" : "sync", projectId, err)
    throw err
  } finally {
    cancelFns.delete(projectId)
    endBusy(st)
  }
}

export async function runClone(
  projectId: string,
  args: { url: string; branch?: string; credId?: string | null },
): Promise<void> {
  const st = guardBusy(projectId, "clone")
  try {
    const transport = await transportFields(args.credId ?? null)
    const op = sdkClone(
      {
        url: args.url,
        targetPath: projectRoot(projectId),
        branch: args.branch ?? "",
        ...transport,
      },
      (m) => {
        st.progress = m
      },
    )
    cancelFns.set(projectId, op.cancel)
    const result = await op.promise
    handles.delete(projectId) // clone may have created the repo natively; let the next op re-ensure fresh
    await saveSetup(projectId, {
      remoteUrl: args.url,
      branch: result.branch,
      ...(args.credId !== undefined && args.credId !== null ? { credId: args.credId } : {}),
    })
  } catch (err) {
    logGitFailure("clone", projectId, err)
    throw err
  } finally {
    cancelFns.delete(projectId)
    endBusy(st)
  }
}

/** Remote branch list for the sync page (memory only). url falls back to the project's stored remote. */
export async function fetchRemoteBranches(
  projectId: string,
  args?: { url?: string; credId?: string | null },
): Promise<BranchInfo[]> {
  const setup = await getSetup(projectId)
  const url = args?.url ?? setup.remoteUrl
  if (!url) {
    throw new GitOpError("no_remote", "No remote repository is set up for this project. Open Git settings first.")
  }
  const st = projectGit(projectId)
  st.branchesLoading = true
  try {
    const credId = args?.credId !== undefined ? args.credId : setup.credId
    const transport = await transportFields(credId ?? null)
    return await sdkLsRemote({ url, ...transport })
  } catch (err) {
    logGitFailure("lsRemote", projectId, err)
    throw err
  } finally {
    st.branchesLoading = false
  }
}

export async function cancelGit(projectId: string): Promise<void> {
  const fn = cancelFns.get(projectId)
  if (fn) await fn()
}

/** App bootstrap hook: hydrate the credential manifest + global options into memory. */
class GitApp {
  async load(): Promise<void> {
    await kGitCredentialStore().load()
    await kGitOptions().load()
  }
}

export const kGitApp = lazyInit<GitApp>(() => new GitApp())
