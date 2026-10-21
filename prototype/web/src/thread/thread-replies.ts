import {
  type Employee,
  type Phase,
  type Reply,
  type V3Ask,
  type V3Data,
  type V3Thread,
  type V3Turn,
  type V3Workbench,
  VIEWER_ID,
} from "@lilos/ui"
import { planOf } from "./mock-plans"
import { modelPick } from "./model-pick"
import { attachedLine, attachmentSteps, diffsOf, isTool, stepOf } from "./thread-steps"

/* One mock turn (a prompt in, steps, an answer out) as the real thread's
   rows: your message, then the agent's reply. Message ids are the ones ⌘K's
   mock search returns (`thread:turn:prompt|answer`), so a search hit lands on
   its message. */

/** An ask the thread is parked on, or has just been answered on (`receipt`). */
export type Ask = { ask: V3Ask; receipt?: string }

export type Ctx = {
  data: V3Data
  t: V3Thread
  wb: V3Workbench | undefined
  lead: Employee
  /** A turn is under way (working, waiting on you, or looping). */
  running: boolean
  ask: Ask | undefined
  /** What the running command has printed so far. */
  live: string[] | undefined
}

/** "12m", "45s", "2h so far" → seconds. */
export function seconds(took: string): number | undefined {
  const m = /^(\d+)\s*(s|m|h)\b/.exec(took)
  if (!m) return undefined
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] as "s" | "m" | "h"]
}

const CLOCK = /\d{1,2}:\d{2}/

/** The clock time a turn started: its prompt's, else the one its "from" names. */
export const turnTime = (t: V3Thread, turn: V3Turn): string =>
  turn.prompt?.at ?? CLOCK.exec(turn.from)?.[0] ?? t.startedAt

export const promptId = (t: V3Thread, n: number) => `${t.id}:${n}:prompt`
const answerId = (t: V3Thread, n: number) => `${t.id}:${n}:answer`

/** The turn number a message id names. */
export const turnOf = (messageId: string): number => Number(messageId.split(":").at(-2))

function phaseOf(
  c: Ctx,
  newest: boolean,
  stage: { working: boolean; waiting: boolean; streaming: boolean; tools: number; think: number },
): Phase {
  if (!stage.working) {
    if (newest && c.t.status === "failed") return "failed"
    // The mock engine's Stop leaves this summary (v3-engine/asks.ts).
    if (newest && c.t.summary === "Stopped by you") return "stopped"
    return "done"
  }
  if (stage.waiting) return "waiting"
  if (stage.streaming) return "typing"
  if (stage.tools === 0) return stage.think > 0 ? "thinking" : "submitted"
  return "tools"
}

const planStatus = { done: "completed", current: "in_progress", todo: "pending" } as const

function agentReply(c: Ctx, turn: V3Turn, newest: boolean, text: string): Reply {
  const { t, lead } = c
  const diffs = diffsOf(c.wb)
  const working = newest && c.running
  const think = (turn.steps ?? []).filter((s) => !isTool(s))
  // A stopped or finished thread has no step still running.
  const tools = (turn.steps ?? []).filter(isTool).map((s) =>
    stepOf({ ...s, running: s.running && working }, diffs, working && s.running ? c.live : undefined),
  )
  const steps = [...tools, ...attachmentSteps(turn.attachments, tools)]
  const ask = newest ? c.ask : undefined
  const proposed = planOf(t, turn)
  // A proposed plan parks the turn like a question does.
  const planAsk = working && proposed?.status === "proposed"
  // An answered ask stays on its card as a receipt; the turn is no longer parked on it.
  const waiting = working && ((!!ask && !ask.receipt) || planAsk)
  const streaming = !!turn.streaming && working
  const phase = phaseOf(c, newest, { working, waiting, streaming, tools: steps.length, think: think.length })
  const secs = working ? undefined : seconds(turn.took)
  const pick = modelPick(c.data, t.model)
  const id = answerId(t, turn.n)
  return {
    from: lead.id,
    time: turnTime(t, turn),
    id,
    turnId: id,
    text: text + attachedLine(turn.attachments),
    ...(pick.model ? { model: pick.model } : {}),
    ...(pick.effort ? { effort: pick.effort } : {}),
    ...(steps.length ? { steps } : {}),
    ...(streaming ? { streaming: turn.answer ?? "" } : {}),
    ...(think.length ? { reasoning: think.map((s) => s.target).join("\n\n") } : {}),
    phase,
    ...(working ? { live: true, postAttach: true } : {}),
    ...(waiting && ask ? { waitingOn: ask.ask.kind } : {}),
    ...(planAsk ? { waitingOn: "plan" as const } : {}),
    ...(phase === "failed" ? { error: t.summary ?? "The turn failed" } : {}),
    ...(secs !== undefined ? { dur: secs } : {}),
    ...(ask?.ask.kind === "approval"
      ? {
          approval: {
            id: ask.ask.id,
            command: ask.ask.ask,
            note: [ask.ask.why, ask.ask.ifYes && `If yes: ${ask.ask.ifYes}`, ask.ask.ifNo && `If no: ${ask.ask.ifNo}`]
              .filter(Boolean)
              .join("\n"),
            options: ["once", "always", "deny"],
          },
        }
      : {}),
    ...(ask?.ask.kind === "question"
      ? {
          question: {
            id: ask.ask.id,
            question: ask.ask.ask,
            options: (ask.ask.options ?? []).map((o) => ({ id: o, label: o })),
          },
        }
      : {}),
    // A thread with a plan to decide carries it on the turn that proposed it; the mock otherwise
    // keeps one task list and one helper list per thread: they belong to its newest turn.
    ...(proposed
      ? { plan: proposed }
      : newest && t.plan
        ? {
            plan: {
              id: `${t.id}:plan`,
              kind: "tasks" as const,
              version: 1,
              steps: t.plan.map((p) => ({ text: p.text, status: planStatus[p.state] })),
              status: "approved" as const,
            },
          }
        : {}),
    ...(newest && t.helpers?.length
      ? {
          subagents: t.helpers.map((h, i) => ({
            id: `${t.id}:helper:${i}`,
            name: h.text,
            task: h.text,
            status: "done" as const,
            steps: [],
            dur: seconds(h.took),
          })),
        }
      : {}),
  }
}

/** The rows of one turn. The turn that opened the thread is its root message
    (the view draws it), so it adds only the agent's reply. */
export function turnRows(c: Ctx, turn: V3Turn, opts: { newest: boolean; opening: boolean }): Reply[] {
  const { newest, opening } = opts
  const rows: Reply[] = []
  const { prompt } = turn
  if (prompt && !opening)
    rows.push({
      from: prompt.by === "you" ? VIEWER_ID : prompt.by,
      time: prompt.at,
      id: promptId(c.t, turn.n),
      text: prompt.text,
      ...(prompt.files?.length ? { attachments: prompt.files } : {}),
    })
  // With no prompt the opening turn's summary is the root message itself.
  const text = turn.answer ?? (opening && !prompt ? undefined : turn.summary) ?? ""
  const hasWork = !!turn.steps?.length || !!turn.attachments?.length || (newest && c.running)
  if (text || hasWork || (newest && c.ask)) rows.push(agentReply(c, turn, newest, text))
  return rows
}
