/**
 * Provider cleanup: when a provider is deleted, clear the project preferences that reference it.
 */
import { listProjects } from "./projects"
import { loadConfig, flushConfigNow } from "./config"

export async function getProjectListIdsByPreferProvider(providerId: string): Promise<string[]> {
  const projects = await listProjects()
  const affected: string[] = []
  for (const project of projects) {
    const cfg = await loadConfig(project.id)
    if (cfg.spec.prefer_provider === providerId) affected.push(project.id)
  }
  return affected
}

/** Clears prefer_provider/prefer_model on the projects that still prefer this provider */
export async function cleanupPreferences(providerId: string, projectIds: string[]): Promise<void> {
  for (const projectId of projectIds) {
    const { setProjectPreference } = await import("./projects")
    setProjectPreference(projectId, { prefer_provider: undefined, prefer_model: undefined })
  }
  await flushConfigNow()
}