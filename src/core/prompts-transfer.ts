/**
 * System prompt kind module for the unified YAML transfer (rule 38 + rule 35): documents of
 * `kind: v1/system_prompt` carrying `{ id?, name, content }` — no secrets in this kind, the content ships
 * verbatim. Built-in Ask / Code rows (`builtin-ask` / `builtin-code`) are NEVER stored rows and NEVER
 * exported; an import document claiming a builtin id is rejected per row.
 *
 * Matching: id hit → update (rename when changed + set content); free id → createWithId preserving it;
 * absent id → create. Because prompt names are unique case-insensitively, a name colliding with a different
 * entry (stored or built-in) is an entry-level error: the document is skipped and reported, never renamed or
 * overwritten automatically. Timestamps never leave the device (createdAt/updatedAt regenerate on import).
 */
import { z } from "zod"
import { isBuiltinSystemPromptId, kSystemPromptStore, SYSTEM_PROMPT_NAME_MAX } from "./system-prompts"
import { KIND_SYSTEM_PROMPT, ID_RE, renderStream } from "./transfer"

export const SYSTEM_PROMPT_DOC_KIND = KIND_SYSTEM_PROMPT

const promptSpecSchema = z.object({
  id: z.string().regex(ID_RE, `id must match ${ID_RE.source}`).optional(),
  name: z.string().trim().min(1, "cannot be empty").max(SYSTEM_PROMPT_NAME_MAX),
  content: z.string().min(1, "cannot be empty").refine((v) => v.trim().length > 0, "cannot be empty"),
})

type PromptSpec = z.infer<typeof promptSpecSchema>

function promptDoc(id: string, name: string, content: string): { kind: string; spec: Record<string, unknown> } {
  return { kind: SYSTEM_PROMPT_DOC_KIND, spec: { id, name, content } }
}

/** Render the custom rows only — built-ins are read-only content shipped with the app. */
export function renderSystemPromptsYaml(): string {
  const docs = kSystemPromptStore()
    .list()
    .filter((entry) => !isBuiltinSystemPromptId(entry.id))
    .map((entry) => promptDoc(entry.id, entry.name, entry.content))
  return renderStream(docs)
}

/** Registry entry: schema check + self-contained apply thunk. */
export function promptTransfer(spec: unknown): { apply?: () => Promise<"created" | "updated">; message?: string } {
  const parsed = promptSpecSchema.safeParse(spec)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue?.path?.length ? ` at ${issue.path.join(".")}` : ""
    return { message: `invalid system_prompt document${at}: ${issue?.message ?? "schema mismatch"}` }
  }
  const data: PromptSpec = parsed.data
  return {
    apply: async () => {
      const store = kSystemPromptStore()
      if (data.id && isBuiltinSystemPromptId(data.id)) {
        throw new Error(`id "${data.id}" belongs to a built-in prompt`)
      }
      const existing = data.id ? store.get(data.id) : undefined
      if (existing) {
        const renamed = existing.name.toLowerCase() !== data.name.toLowerCase()
        if (renamed && store.nameTaken(data.name, existing.id)) {
          throw new Error("a prompt with this name already exists")
        }
        if (renamed) await store.rename(existing.id, data.name)
        await store.setContent(existing.id, data.content)
        return "updated" as const
      }
      if (store.nameTaken(data.name)) {
        throw new Error("a prompt with this name already exists")
      }
      if (data.id) await store.createWithId(data.id, data.name, data.content)
      else await store.create(data.name, data.content)
      return "created" as const
    },
  }
}
