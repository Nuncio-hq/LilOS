import {
  agentNameOf,
  agentOf,
  type BackgroundJob,
  type Channel,
  type Employee,
  type EmpFn,
  type HumanFn,
  type Msg,
  type PullRequest,
  type QueuedTrayItem,
  type Reply,
  type Thread,
  type Usage,
  type V3Data,
  type V3Thread,
  type V3Workbench,
  VIEWER_ID,
  type Work,
} from "@lilos/ui"
import { threadProjectId } from "@lilos/ui/v3-data"
import { modelIdOf } from "../fake-v3-models"
import { modelPick } from "./model-pick"
import { type Ask, type Ctx, promptId, turnRows, turnTime } from "./thread-replies"

/* The mock company's thread (V3Thread: turns, newest first, each a prompt,
   steps and an answer) as the real conversation the thread view reads (a
   Thread of replies, your rows and the agent's mixed, oldest first). The view
   is the app's own; this only speaks its language, so what the prototype shows
   is what the app would show for the same conversation. */

export type { Ask }

export type ThreadModel = {
  root: Extract<Msg, { kind: "msg" }>
  thread: Thread
  channel: Channel
  lead: Employee
  emp: EmpFn
  human: HumanFn
  mentionables: Employee[]
  work: Work | null
  running: boolean
  pending: QueuedTrayItem[]
  lastSent: string | undefined
}

/** The context window the mock assumes when the catalog names none. */
const WINDOW = 200_000

const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path

/** The pull request the workbench says the branch has. */
function prOf(t: V3Thread, wb: V3Workbench | undefined, who: string): PullRequest | undefined {
  const pr = wb?.pr
  if (!pr) return undefined
  const check = { passing: "passed", running: "pending", failing: "failed" } as const
  return {
    number: pr.num,
    repo: basename(t.folder ?? ""),
    title: pr.title,
    body: "",
    status: pr.state === "merged" ? "merged" : "open",
    ...(pr.state === "draft" ? { draft: true } : {}),
    mergeable: "unknown",
    author: who,
    base: "main",
    head: t.branch ?? "",
    opened: t.startedAt,
    checks: [{ name: "CI", status: check[pr.checks] }],
    comments: [],
  }
}

function jobsOf(t: V3Thread, wb: V3Workbench | undefined): BackgroundJob[] {
  return (wb?.jobs ?? []).map((j, i) => ({
    id: `${t.id}:job:${i}`,
    command: j.cmd,
    status: j.state === "done" ? "exited" : j.state,
    started: t.startedAt,
    uptime: `${t.minutes}m`,
    ...(j.state === "done" ? { exitCode: 0 } : j.state === "failed" ? { exitCode: 1 } : {}),
    log: j.tail,
  }))
}

/** The thread after you stop one of its background jobs (`id` is one `jobsOf` made): it ends cleanly. */
export function stopJob(t: V3Thread, id: string): V3Thread {
  const wb = t.workbench
  if (!wb) return t
  const at = Number(id.split(":").at(-1))
  return { ...t, workbench: { ...wb, jobs: wb.jobs.map((j, i) => (i === at ? { ...j, state: "done" as const } : j)) } }
}

/** The thread's own people: you, and whoever else wrote a prompt (the CEO, a hand-off). */
function peopleOf(data: V3Data, t: V3Thread): HumanFn {
  const others = new Set(t.turns.flatMap((x) => (x.prompt && x.prompt.by !== "you" ? [x.prompt.by] : [])))
  others.delete(t.agentId)
  return (id) =>
    id === VIEWER_ID
      ? { name: data.me, color: "bg-sky-600" }
      : others.has(id)
        ? { name: agentNameOf(data, id), color: "bg-violet-600" }
        : undefined
}

export function threadModel(
  data: V3Data,
  t: V3Thread,
  archived: boolean,
  opts: { ask?: Ask; live?: string[] },
): ThreadModel {
  const agent = agentOf(data, t.agentId)
  const name = agentNameOf(data, t.agentId)
  const wb = t.workbench
  const options = data.modelCatalog?.options
  const label = t.model ?? agent?.model
  const lead: Employee = {
    id: t.agentId,
    name,
    role: agent?.role ?? "",
    status: t.status === "working" ? "busy" : "online",
    profile: agent?.profile ?? t.agentId,
    model: (label && options ? modelIdOf(options, label) : undefined) ?? agent?.modelId ?? "",
    now: t.now?.text ?? "",
    instructions: agent?.instructions.join("\n") ?? "",
    respondTo: "me",
  }
  // A thread waiting on you or looping still has its turn open.
  const running = t.status === "working" || t.status === "needs" || t.status === "stuck"
  const turns = [...t.turns].sort((a, b) => a.n - b.n)
  const first = turns[0]
  const newest = turns.at(-1)
  const pr = prOf(t, wb, name)
  const ctx: Ctx = { data, t, wb, lead, running, ask: opts.ask, live: opts.live }

  const root: ThreadModel["root"] = first?.prompt
    ? {
        kind: "msg",
        id: promptId(t, first.n),
        from: first.prompt.by === "you" ? VIEWER_ID : first.prompt.by,
        time: first.prompt.at,
        text: first.prompt.text,
        ...(first.prompt.files?.length ? { attachments: first.prompt.files } : {}),
      }
    : {
        // A thread an agent opened, or one rewound to nothing, has no message of yours to open on:
        // the root is empty (the view draws no bubble, the header still reads when it began, and
        // it is not a turn you sent) and the agent's own opening line is its first reply.
        kind: "msg",
        id: `${t.id}:root`,
        from: lead.id,
        time: first ? turnTime(t, first) : t.startedAt,
        text: "",
      }

  const replies: Reply[] = turns.flatMap((turn) =>
    turnRows(ctx, turn, { newest: turn === newest, opening: turn === first }),
  )
  // A rewind has no card of its own. Stuck is the shared card (D-#772):
  // the thread carries the reason and ThreadView draws it.
  if (t.rewound) {
    const { dropped, files } = t.rewound
    replies.push({
      from: "",
      time: "",
      id: `${t.id}:rewound`,
      system: true,
      text: `Rewound to before your message. ${dropped} ${dropped === 1 ? "message" : "messages"} dropped${files ? ", files restored" : ""}.`,
    })
  }

  const jobs = jobsOf(t, wb)
  // The project the thread files under — its own record, its ticket's, or
  // the project whose folder holds the thread's (#854).
  const project = data.projects.find((p) => p.id === threadProjectId(data, t))
  const pick = modelPick(data, label)
  const window = options?.find((o) => o.id === pick.model)?.contextWindow ?? WINDOW
  const used = t.context !== undefined ? Math.round((t.context / 100) * window) : undefined
  const usage: Usage | undefined =
    used !== undefined
      ? { input: used, output: Math.round(used / 8), reasoning: 0, cache: 0, context: used, contextWindow: window }
      : undefined
  const queued = newest?.queued ?? []

  const thread: Thread = {
    session: t.id.replace(/^t-/, ""),
    ...(t.ticketId ? { ticket: t.ticketId } : {}),
    ...(t.branch ? { branch: t.branch } : {}),
    title: t.title,
    archived,
    replies,
    // Messages sent mid-turn that a Stop left unread wait in the not-sent tray.
    queue: running ? [] : queued.map((q) => q.text),
    ...(usage ? { usage } : {}),
    ...(pick.model ? { model: pick.model } : {}),
    ...(pick.provider ? { provider: pick.provider } : {}),
    ...(pick.effort ? { effort: pick.effort } : {}),
    ...(pick.fast ? { fast: true } : {}),
    ...(pr ? { pr } : {}),
    ...(t.folder
      ? {
          ws: {
            folder: t.folder,
            project: project?.name ?? basename(t.folder),
            mode: t.branch ? ("existing" as const) : ("direct" as const),
            base: "main",
            branch: t.branch ?? "main",
            cwd: t.folder,
          },
        }
      : {}),
    ...(jobs.length ? { jobs, bgJobs: jobs.filter((j) => j.status === "running").length } : {}),
    // D-#772: the card only while the status is stuck, same as the app.
    ...(t.status === "stuck" && t.stuck ? { stuck: t.stuck.what } : {}),
  }

  return {
    root,
    thread,
    channel: { id: `ch-${t.id}`, name, dm: true, employees: [lead.id] },
    lead,
    emp: (id) => (id === lead.id ? lead : undefined),
    human: peopleOf(data, t),
    mentionables: data.agents
      .filter((a) => a.id !== t.agentId && a.kind !== "outside")
      .map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        status: "online" as const,
        profile: a.profile ?? a.id,
        model: a.modelId ?? "",
        now: "",
        instructions: "",
        respondTo: "me" as const,
      })),
    work: t.folder
      ? {
          ticket: t.ticketId ?? "",
          title: t.title,
          path: t.folder,
          ...(t.branch ? { branch: t.branch } : {}),
        }
      : null,
    running,
    pending: running ? queued.map((q) => ({ text: q.text, removable: true })) : [],
    lastSent: turns.filter((x) => x.prompt?.by === "you").at(-1)?.prompt?.text,
  }
}
