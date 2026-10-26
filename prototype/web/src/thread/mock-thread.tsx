import {
  type AttachedFile,
  boardStatus,
  FocusView,
  type ModelChoice,
  type PlanAction,
  snoozed,
  ThreadLineage,
  ThreadView,
  type V3Ask,
  type V3PageProps,
  type WbTab,
} from "@lilos/ui"
import { useEffect, useMemo, useRef, useState } from "react"
import { nowClock } from "../v3-engine/chat-sim"
import { MockBrowser } from "./mock-browser"
import { mockHost } from "./mock-host"
import { PLAN_CHANGE_PREFIX, isPlanChange, newestTurn, planWaiting, queueOnNewest, reviseTurn } from "./mock-plans"
import { useMockSurfaces } from "./mock-surfaces"
import { pickLabel } from "./model-pick"
import type { ThreadSeams } from "./seams"
import { stopJob, threadModel } from "./thread-model"
import { turnOf } from "./thread-replies"

/* The real thread view (ThreadView beside a page, FocusView widened into the
   session) on a mock thread: the same components the app mounts, fed by the
   mapper in thread-model.ts, with mock seams for what the app backs with
   the relay, the Mac's folder and the engine (mock-host, mock-surfaces,
   seams). A control exists when its action does, as in the app. */

const EDITORS = [{ id: "cursor" as const, name: "Cursor" }]

export function MockThread(
  props: V3PageProps & {
    id: string
    session: boolean
    onSession: (open: boolean) => void
    seams: ThreadSeams
    scrollTo?: string
    onScrolled?: () => void
  },
) {
  // Keyed: another thread starts with fresh draft, tab and receipts.
  return <Body key={props.id} {...props} />
}

function Body({
  data,
  go,
  act,
  id,
  session,
  onSession,
  seams,
  scrollTo,
  onScrolled,
}: Parameters<typeof MockThread>[0]) {
  const live = data.threads.find((x) => x.id === id)
  const t = live ?? data.archivedThreads?.find((x) => x.id === id)
  const [draft, setDraft] = useState("")
  const [seed, setSeed] = useState<AttachedFile[]>()
  const [tab, setTab] = useState<WbTab>()
  const [modelOpen, setModelOpen] = useState(false)
  const [access, setAccess] = useState(data.settings.approvals)
  // What you answered on a card: the card stays, as a receipt, after the
  // mock engine has closed the ask.
  const [resolved, setResolved] = useState<Record<string, string>>({})
  const [lastAsk, setLastAsk] = useState<V3Ask>()
  const current = t?.askId ? data.asks.find((a) => a.id === t.askId) : undefined
  useEffect(() => {
    if (current) setLastAsk(current)
  }, [current])
  const ask = current ?? (lastAsk && resolved[lastAsk.id] ? lastAsk : undefined)

  // The running command's output arrives line by line.
  const liveLines = t?.live?.lines
  const liveCmd = t?.live?.cmd
  const [shown, setShown] = useState(2)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new command starts its output again
  useEffect(() => {
    setShown(2)
    if (!liveLines) return
    const timer = window.setInterval(() => setShown((n) => Math.min(liveLines.length, n + 1)), 1500)
    return () => window.clearInterval(timer)
  }, [liveCmd, liveLines])

  const unseen = t?.unseen
  const { markSeen } = act
  useEffect(() => {
    if (unseen) markSeen(id)
  }, [unseen, id, markSeen])

  const model = useMemo(
    () =>
      t &&
      threadModel(data, t, !live, {
        ask: ask && { ask, receipt: resolved[ask.id] },
        live: liveLines?.slice(0, shown),
      }),
    [data, t, live, ask, resolved, liveLines, shown],
  )
  const pr = model?.thread.pr
  const say = seams.toast
  // The host reads the thread as it is now, so a turn that lands later still shows its changes.
  const latest = useRef(t)
  if (t) latest.current = t
  // The host keeps what you do in the folder (a commit, a PR): one per thread.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the mock folder is read once per thread
  const host = useMemo(() => (t ? mockHost(() => latest.current ?? t, pr, say) : undefined), [id, say])
  const surfaces = useMockSurfaces(t)

  if (!t || !model || !host)
    return (
      <div className="grid h-full place-items-center p-6 text-muted-foreground text-sm">
        This thread no longer exists.
      </div>
    )

  const options = data.modelCatalog?.options
  const catalog = data.modelCatalog
  const { thread, root, lead, running } = model
  const limits = data.attachLimits
  const rewindTurn = (messageId: string) => {
    const n = turnOf(messageId)
    const turn = t.turns.find((x) => x.n === n)
    if (!turn?.prompt) return
    // The rewind applies at once; Undo (10 s, as in the app) puts the thread, the draft and the chips back.
    const before = { thread: t, draft }
    setDraft(turn.prompt.text)
    setSeed(turn.prompt.files)
    act.rewind?.(t.id, n)
    say("Turn rewound — Undo brings the messages and file changes back (10 s).", {
      action: {
        label: "Undo",
        run: () => {
          seams.patch(t.id, () => before.thread)
          setDraft(before.draft)
          setSeed(undefined)
        },
      },
    })
  }
  // Approve, Reject and Change on a plan waiting for you; Change starts your reply in the box.
  const onPlan = (action: PlanAction) => {
    if (action === "change") {
      setDraft(PLAN_CHANGE_PREFIX)
      return
    }
    // An untouched "Change the plan: " goes with the decision.
    if (draft === PLAN_CHANGE_PREFIX) setDraft("")
    // The plan is the thread's ask: deciding it here, on its Threads card or on Needs is one act.
    if (!t.askId) return
    if (action === "approve") act.approve(t.askId)
    else act.deny(t.askId)
  }
  // A send that keeps the "Change the plan: " prefix answers the plan; any other message waits for your decision.
  const sendHere = (text: string, files?: AttachedFile[]) => {
    if (isPlanChange(t, text)) return seams.patch(t.id, (th) => reviseTurn(th, text.trim(), nowClock()))
    if (planWaiting(t)) return seams.patch(t.id, (th) => queueOnNewest(th, text, nowClock()))
    seams.send(t.id, text, files)
  }
  // The newest turn's unread messages: waiting while it runs, "not sent" once a Stop left them.
  const dropQueued = (i: number) =>
    seams.patch(t.id, (th) => {
      const newest = newestTurn(th)
      return {
        ...th,
        turns: th.turns.map((u) => (u === newest ? { ...u, queued: u.queued?.filter((_, j) => j !== i) } : u)),
      }
    })
  // What the composer reaches for in both frames: @files, /commands, and the people to mention.
  const onSearchFiles =
    act.searchFiles && t.folder
      ? (q: string) => act.searchFiles?.(t.folder ?? "", q) ?? Promise.resolve([])
      : undefined
  const onSearchCommands = act.searchCommands
    ? (q: string) =>
        act.searchCommands?.({ agentId: t.agentId, folder: t.folder }, q) ?? Promise.resolve([])
    : undefined
  const shared = {
    root,
    thread,
    channel: model.channel,
    emp: model.emp,
    human: model.human,
    resolved,
    setResolved: (r: Record<string, string>) => {
      const hit = Object.entries(r).find(([k, v]) => resolved[k] !== v)
      if (!hit) return
      const [askId, label] = hit
      setResolved(r)
      if (/^denied/i.test(label)) act.deny(askId)
      else act.approve(askId, /always/i.test(label))
    },
    onAnswer: (q: { id: string }, a: { value: string }) => {
      setResolved((r) => ({ ...r, [q.id]: `Answered “${a.value}” by ${data.me}` }))
      act.answer(q.id, a.value)
    },
    onCancel: (q: { id: string }) => {
      setResolved((r) => ({ ...r, [q.id]: `Cancelled by ${data.me}` }))
      act.deny(q.id)
    },
    running,
    steer: true,
    models: options,
    picker: catalog && {
      providers: catalog.providers,
      visibility: catalog.visibility,
      onVisibility: act.setModelVisibility,
      onRefresh: act.refreshModels,
    },
    defaultModel: catalog?.defaultModel,
    defaultProvider: catalog?.defaultProvider,
    onCommand: (name: string) => name === "model" && (setModelOpen(true), true),
    modelOpen,
    onModelOpen: setModelOpen,
    access,
    onAccess: (a: typeof access) => {
      setAccess(a)
      say(a === "full" ? "Full access for this thread" : "This thread asks first")
    },
    onRename: act.renameThread && ((title: string) => act.renameThread?.(t.id, title)),
    onArchive: act.archiveThread && ((to: boolean) => act.archiveThread?.(t.id, to)),
    /* The ⋯ menu's park choices (#862): pin, snooze/wake, auto-settle —
       each drawn only with its action. A settled thread's menu suppresses
       them in the shared menu itself. */
    park: {
      pinned: t.pinnedAt !== undefined,
      onPin: act.pinThread && ((to: boolean) => act.pinThread?.(t.id, to)),
      snoozedUntil: snoozed(t) ? t.snoozedUntil : undefined,
      onSnooze: act.snoozeThread && ((until: number) => act.snoozeThread?.(t.id, until)),
      onWake: act.wakeThread && (() => act.wakeThread?.(t.id)),
      autoSettle: !t.autoSettleOff,
      onAutoSettle: act.setAutoSettle && ((on: boolean) => act.setAutoSettle?.(t.id, on)),
    },
    onSend: sendHere,
    pending: model.pending,
    onRemovePending: dropQueued,
    onUnqueue: dropQueued,
    onSendQueued: (i: number) => {
      const text = newestTurn(t)?.queued?.[i]?.text
      dropQueued(i)
      if (text) seams.send(t.id, text)
    },
    draft,
    onDraftChange: setDraft,
    accept: limits ? "*/*" : undefined,
    maxFileSize: limits?.maxFileBytes,
    onAttachError: say,
    onStop: running ? () => act.stop(t.id) : undefined,
    lastSent: model.lastSent,
    onRetry: model.lastSent ? () => seams.send(t.id, model.lastSent ?? "") : undefined,
    onRewind: act.rewind && rewindTurn,
    onPlan,
    seedFiles: seed,
    onSeededFiles: () => setSeed(undefined),
    editors: EDITORS,
    onCompact: () => {
      seams.patch(t.id, (th) => ({ ...th, context: 6 }))
      say("Compacted · the thread keeps its meaning in far fewer tokens")
    },
    onModel: (c: ModelChoice) => {
      const label = pickLabel(data, c)
      seams.patch(t.id, (th) => ({ ...th, model: label }))
    },
    scrollTo,
    onScrolled,
    lead,
    maxFiles: limits?.maxFiles,
    mentionables: model.mentionables,
    onSearchFiles,
    onSearchCommands,
  }
  const onOpenPath = (path: string, app: string) => say(`Opened ${path} in ${app}`)

  return (
    <div data-thread-panel className="flex h-full min-h-0 min-w-0 flex-col">
      {/* A hand-off is an ordinary thread with lineage (D-#847): the page
          leads with the parent a helper belongs to, or the helpers a
          parent is waiting on — nothing on an ordinary thread. The park
          line joins it while the thread is off the lists (#862). */}
      <ThreadLineage data={data} thread={t} go={go} act={act} settled={!live} />
      {session ? (
        <FocusView
          bare
          {...shared}
          work={model.work}
          /* The header wears the board status too (D-#847): a parent waiting
             on helpers reads Working here as on every list. */
          threadStatus={boardStatus(data, t)}
          onBack={() => onSession(false)}
          say={say}
          host={host}
          surfaces={surfaces}
          browser={act.browserOpen ? <MockBrowser data={data} act={act} threadId={t.id} /> : undefined}
          initialTab={tab}
          onTab={setTab}
          onStopJob={(jobId) => seams.patch(t.id, (th) => stopJob(th, jobId))}
          caps={{ plan: true, subagents: true, background: true }}
          onSuggest={(files) => `Update ${files.join(", ")}`.slice(0, 72)}
          onOpenPath={onOpenPath}
        />
      ) : (
        <ThreadView
          {...shared}
          work={t.ticketId ? model.work : null}
          onOpenPath={onOpenPath}
          threadStatus={boardStatus(data, t)}
          browser={!!act.browserOpen}
          onOpenTab={(next) => {
            setTab(next)
            onSession(true)
          }}
        />
      )}
    </div>
  )
}
