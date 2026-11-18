/**
 * Git UI runtime state: per-project busy/progress (drives the upload/sync/clone dialogs) plus the
 * in-memory-only remote branch table for the sync page (never persisted, cleared when the page unmounts).
 * Native handles and cancel closures live in core/git.ts (not serializable, not observable).
 */
import { proxy } from "valtio"

export type GitOpKind = "upload" | "sync" | "clone"

export interface ProjectGitRuntime {
  busy: boolean
  kind: GitOpKind | null
  progress: string
  branchesLoading: boolean
}

function emptyRuntime(): ProjectGitRuntime {
  return { busy: false, kind: null, progress: "", branchesLoading: false }
}

export const gitState = proxy<{
  byProject: Record<string, ProjectGitRuntime>
}>({
  byProject: {},
})

export function projectGit(projectId: string): ProjectGitRuntime {
  if (!gitState.byProject[projectId]) gitState.byProject[projectId] = emptyRuntime()
  return gitState.byProject[projectId]
}
