/**
 * Skill kind module for the unified YAML transfer (rule 38 + rule 36): documents of `kind: v1/skill`
 * carrying `{ id?, name, content }` — the same shape as system prompts, but the name is the slash-token
 * identifier and stays locked to the grammar of rule 36 (`[A-Za-z0-9_-]+`, ≤ 24, case-insensitively unique).
 * An import can therefore never introduce a token that the draft scanner could not type.
 *
 * Matching mirrors prompts: id hit → update; free id → createWithId; absent → create. A name colliding with a
 * different skill is an entry-level error (skipped row), never renamed. Expanded text in old drafts/messages
 * is untouched — a rename/delete/overwrite only changes future matching. Timestamps are not exported.
 */
import { z } from "zod"
import { kSkillStore, SKILL_NAME_MAX, SKILL_NAME_RE } from "./skills"
import { KIND_SKILL, ID_RE, renderStream } from "./transfer"

export const SKILL_DOC_KIND = KIND_SKILL

const skillSpecSchema = z.object({
  id: z.string().regex(ID_RE, `id must match ${ID_RE.source}`).optional(),
  name: z
    .string()
    .trim()
    .min(1, "cannot be empty")
    .max(SKILL_NAME_MAX)
    .regex(SKILL_NAME_RE, "name must match [A-Za-z0-9_-]+"),
  content: z.string().min(1, "cannot be empty").refine((v) => v.trim().length > 0, "cannot be empty"),
})

type SkillSpec = z.infer<typeof skillSpecSchema>

/** Render every stored skill (there are no built-ins in this registry). */
export function renderSkillsYaml(): string {
  const docs = kSkillStore().list().map((s) => ({ kind: SKILL_DOC_KIND, spec: { id: s.id, name: s.name, content: s.content } }))
  return renderStream(docs)
}

/** Registry entry: schema check + self-contained apply thunk. */
export function skillTransfer(spec: unknown): { apply?: () => Promise<"created" | "updated">; message?: string } {
  const parsed = skillSpecSchema.safeParse(spec)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue?.path?.length ? ` at ${issue.path.join(".")}` : ""
    return { message: `invalid skill document${at}: ${issue?.message ?? "schema mismatch"}` }
  }
  const data: SkillSpec = parsed.data
  return {
    apply: async () => {
      const store = kSkillStore()
      const existing = data.id ? store.get(data.id) : undefined
      if (existing) {
        const renamed = existing.name.toLowerCase() !== data.name.toLowerCase()
        if (renamed && store.nameTaken(data.name, existing.id)) {
          throw new Error("a skill with this name already exists")
        }
        if (renamed) await store.rename(existing.id, data.name)
        await store.setContent(existing.id, data.content)
        return "updated" as const
      }
      if (store.nameTaken(data.name)) {
        throw new Error("a skill with this name already exists")
      }
      if (data.id) await store.createWithId(data.id, data.name, data.content)
      else await store.create(data.name, data.content)
      return "created" as const
    },
  }
}
