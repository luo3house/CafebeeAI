/**
 * Project config: zod schema + read/write + debounced persistence for `project-meta/<id>/config.yaml`
 * (app-owned state outside the Project directory - the workspace stays pure user files).
 * kind is the brand-free literal `v1/config`. Tolerance rule: only a kind mismatch or structural corruption
 * counts as an "empty preference"; missing fields go through the partial parse.
 */
import { z } from "zod"
import { parse, stringify } from "yaml"
import { joinPath, readText, ensureDir, exists, atomicWriteText, projectMetaDir } from "./fs"

export const CONFIG_DOC_KIND = "v1/config"

export const StaticFsSpecSchema = z.object({
  port: z.number().int().min(1024).max(65535).optional(),
  net_mode: z.enum(["local", "any"]).optional(),
})

export type StaticFsSpec = z.infer<typeof StaticFsSpecSchema>

export const GitSpecSchema = z.object({
  branch: z.string().optional(),
  cred_id: z.string().optional(),
  remote_url: z.string().optional(),
})

export type GitSpec = z.infer<typeof GitSpecSchema>

export const ProjectConfigSpecSchema = z.object({
  prefer_provider: z.string().optional(),
  prefer_model: z.string().optional(),
  display_name: z.string().optional(),
  static_fs: StaticFsSpecSchema.optional(),
  git: GitSpecSchema.optional(),
})

export const ProjectConfigSchema = z.object({
  kind: z.literal(CONFIG_DOC_KIND),
  spec: ProjectConfigSpecSchema,
})

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>
export type ProjectConfigSpec = z.infer<typeof ProjectConfigSpecSchema>

export const EMPTY_CONFIG: ProjectConfig = { kind: CONFIG_DOC_KIND, spec: {} }

function emptyConfig(): ProjectConfig {
  return { kind: CONFIG_DOC_KIND, spec: {} }
}

function projectConfigDir(projectId: string): string {
  return projectMetaDir(projectId)
}

function configPathFor(projectId: string): string {
  return joinPath(projectConfigDir(projectId), "config.yaml")
}

/**
 * Deserialization. Any YAML parse failure / kind mismatch / structural corruption → empty preference.
 * Only individual spec fields missing → partial tolerance.
 * At read time, layer in debounce deltas not yet flushed (pendingDebounce), so that within the 500ms window
 * (e.g. returning to the chat page after switching Provider, where focus immediately refreshes the UI) we do not read stale values and leave the indicator un-updated.
 */
export async function loadConfig(projectId: string): Promise<ProjectConfig> {
  const disk = await readDiskConfig(projectId)
  const pending = pendingDebounce.get(projectId)
  if (!pending || !Object.keys(pending.specPart).length) return disk
  return { kind: CONFIG_DOC_KIND, spec: { ...disk.spec, ...pending.specPart } }
}

async function readDiskConfig(projectId: string): Promise<ProjectConfig> {
  const path = configPathFor(projectId)
  if (!(await exists(path))) return emptyConfig()
  try {
    const raw = await readText(path)
    const doc = parse(raw)
    if (!doc || typeof doc !== "object") return emptyConfig()
    const result = ProjectConfigSchema.safeParse(doc)
    if (result.success) return result.data
    const partial = parseDocToPartial(doc)
    return partial
  } catch {
    return emptyConfig()
  }
}

/** Unknown kind or wholesale corruption → straight to empty preference; otherwise carry back whatever fields exist */
function parseDocToPartial(doc: unknown): ProjectConfig {
  const obj = doc as Record<string, unknown>
  if (obj && obj.kind !== CONFIG_DOC_KIND) return emptyConfig()
  const specCandidate = (obj && obj.spec && typeof obj.spec === "object" ? obj.spec : {}) as Record<string, unknown>
  const spec: ProjectConfigSpec = {}
  for (const key of ["prefer_provider", "prefer_model", "display_name"] as const) {
    const v = specCandidate[key]
    if (typeof v === "string") spec[key] = v
  }
  const fsRaw = specCandidate.static_fs
  if (fsRaw && typeof fsRaw === "object") {
    const parsed = StaticFsSpecSchema.safeParse(fsRaw)
    if (parsed.success) spec.static_fs = parsed.data
  }
  const gitRaw = specCandidate.git
  if (gitRaw && typeof gitRaw === "object") {
    const parsed = GitSpecSchema.safeParse(gitRaw)
    if (parsed.success) spec.git = parsed.data
  }
  return { kind: CONFIG_DOC_KIND, spec }
}

/** Atomic config write */
export async function writeConfig(projectId: string, cfg: ProjectConfig): Promise<void> {
  await ensureDir(projectConfigDir(projectId))
  const text = stringify(cfg)
  await atomicWriteText(configPathFor(projectId), text)
}

/**
 * Preference-entry-level write (with debounce).
 * Multiple fields are merged and persisted once; consecutive calls within 500ms result in a single write.
 */
const pendingDebounce = new Map<string, { specPart: Partial<ProjectConfigSpec>; timer?: ReturnType<typeof setTimeout> }>()

export function setPreferences(
  projectId: string,
  part: Partial<ProjectConfigSpec>,
  opts?: { immediate?: boolean }
): void {
  const rec = pendingDebounce.get(projectId) ?? { specPart: {} }
  Object.assign(rec.specPart, part)
  pendingDebounce.set(projectId, rec)
  if (rec.timer) clearTimeout(rec.timer)
  const flush = () => {
    const current = pendingDebounce.get(projectId)
    if (!current) return
    pendingDebounce.delete(projectId)
    void flushToDisk(projectId, current.specPart)
  }
  if (opts?.immediate) {
    flush()
  } else {
    rec.timer = setTimeout(flush, 500)
  }
}

async function flushToDisk(projectId: string, specPart: Partial<ProjectConfigSpec>): Promise<void> {
  try {
    const cfg = await loadConfig(projectId)
    const clean: Partial<ProjectConfigSpec> = {}
    for (const [k, v] of Object.entries(specPart)) {
      if (v !== undefined && v !== null && v !== "") (clean as Record<string, unknown>)[k] = v
    }
    const spec = { ...cfg.spec, ...clean }
    await writeConfig(projectId, { kind: CONFIG_DOC_KIND, spec })
  } catch {
    // Disk-write failure is silent (the next debounce writes again)
  }
}

/** Flush to disk immediately and wait (process exit / manual invocation) */
export async function flushConfigNow(projectId?: string): Promise<void> {
  for (const [pid, rec] of [...pendingDebounce.entries()]) {
    if (projectId && pid !== projectId) continue
    if (rec.timer) clearTimeout(rec.timer)
    pendingDebounce.delete(pid)
    await flushToDisk(pid, rec.specPart)
  }
}
