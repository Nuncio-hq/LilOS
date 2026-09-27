import type { EngineProfile, ModelOption } from "@lilos/ui"

/* Engine API client for the prototype: POST /api/engine carries one JSON-RPC frame
   to the dev middleware (vite.config.ts → engine-plugin.ts), which runs a real
   `@lilos/engine-fake` on this machine. In the real app these calls go
   relay → harness → engine (issue #26/#27). Every helper returns null (or rethrows)
   on transport failure so the app can fall back to mock data when the plugin
   is not serving. */

let seq = 0
async function engine<T>(method: string, params?: unknown): Promise<T> {
  const res = await fetch("/api/engine", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
  })
  const frame = (await res.json()) as { result?: T; error?: { message: string } }
  if (frame.error) throw new Error(frame.error.message)
  return frame.result as T
}

type AgentDescriptor = {
  id: string
  name?: string
  description?: string
  model?: string
  skillCount?: number
  soul?: string
}

/** `agents.list` + `agents.describe` per profile → the dialog's rows (soul is describe-only). */
export async function engineProfiles(): Promise<EngineProfile[] | null> {
  try {
    const { agents } = await engine<{ agents: AgentDescriptor[] }>("agents.list")
    return await Promise.all(
      agents.map(async (a) => {
        const d = await engine<{ agent: AgentDescriptor }>("agents.describe", { id: a.id })
        const agent = d.agent ?? {}
        return {
          id: a.id,
          name: a.name,
          model: a.model ?? "default",
          soul: agent.soul ?? "",
          skills: a.skillCount ?? 0,
        }
      }),
    )
  } catch {
    return null
  }
}

/** `models.list` → the catalog, default first. null when the engine isn't reachable. */
export async function engineModels(): Promise<ModelOption[] | null> {
  try {
    const r = await engine<{ models: ModelOption[]; default?: string }>("models.list")
    const rest = r.models.filter((m) => m.id !== r.default)
    const first =
      r.models.find((m) => m.id === r.default) ??
      (r.default ? { id: r.default } : undefined)
    return first ? [first, ...rest] : rest
  } catch {
    return null
  }
}

/** `agents.create` — a new real engine profile. Returns the created descriptor. */
export function engineCreateAgent(p: {
  id: string
  name?: string
  soul?: string
  model?: string
}): Promise<AgentDescriptor> {
  return engine<AgentDescriptor>("agents.create", {
    name: p.id,
    ...(p.name ? { description: p.name } : {}),
    ...(p.soul ? { soul: p.soul } : {}),
    ...(p.model ? { model: p.model } : {}),
  })
}
