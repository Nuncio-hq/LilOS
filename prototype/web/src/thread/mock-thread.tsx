import {
  type AttachedFile,
  FocusView,
  type ModelChoice,
  ThreadView,
  type V3Ask,
  type V3PageProps,
  type WbTab,
} from "@lilos/ui"
import { useEffect, useMemo, useState } from "react"
import { MockBrowser } from "./mock-browser"
import { mockHost } from "./mock-host"
import { useMockSurfaces } from "./mock-surfaces"
import type { ThreadSeams } from "./seams"
import { pickLabel } from "./model-pick"
import { threadModel } from "./thread-model"
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
  const wb = t?.workbench
  const pr = model?.thread.pr
  const say = seams.toast
  // The host keeps what you do in the folder (a commit, a PR): one per thread.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the mock folder is read once per thread
  const host = useMemo(() => (t ? mockHost(t, pr, say) : undefined), [id, wb, say])
  const surfaces = useMockSurfaces(wb)

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
    setDraft(turn.prompt.text)
    setSeed(turn.prompt.files)
    act.rewind?.(t.id, n)
  }
  // The newest turn's unread messages: waiting while it runs, "not sent" once a Stop left them.
  const dropQueued = (i: number) =>
    seams.patch(t.id, (th) => ({
      ...th,
      turns: th.turns.map((u, k) =>
        k === 0 ? { ...u, queued: u.queued?.filter((_, j) => j !== i) } : u,
      ),
    }))
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
    onSend: (text: string, files?: AttachedFile[]) => seams.send(t.id, text, files),
    pending: model.pending,
    onRemovePending: dropQueued,
    onUnqueue: dropQueued,
    onSendQueued: (i: number) => {
      const text = t.turns[0]?.queued?.[i]?.text
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
  }
  const mentionables = model.mentionables
  const onSearchFiles =
    act.searchFiles && t.folder
      ? (q: string) => act.searchFiles?.(t.folder ?? "", q) ?? Promise.resolve([])
      : undefined
  const onSearchCommands = act.searchCommands
    ? (q: string) =>
        act.searchCommands?.({ agentId: t.agentId, folder: t.folder }, q) ?? Promise.resolve([])
    : undefined
  const onOpenPath = (path: string, app: string) => say(`Opened ${path} in ${app}`)

  return (
    <div data-thread-panel className="flex h-full min-h-0 min-w-0 flex-col">
      {session ? (
        <FocusView
          bare
          {...shared}
          lead={lead}
          work={model.work}
          threadStatus={t.status}
          onBack={() => onSession(false)}
          say={say}
          host={host}
          surfaces={surfaces}
          browser={act.browserOpen ? <MockBrowser data={data} act={act} threadId={t.id} /> : undefined}
          initialTab={tab}
          onTab={setTab}
          onStopJob={(jobId) => {
            const job = thread.jobs?.find((j) => j.id === jobId)
            if (job) act.message(t.id, `Stop \`${job.command}\``)
          }}
          caps={{ plan: true, subagents: true, background: true }}
          onSuggest={(files) => `Update ${files.join(", ")}`.slice(0, 72)}
          onOpenPath={onOpenPath}
        />
      ) : (
        <ThreadView
          {...shared}
          work={t.ticketId ? model.work : null}
          maxFiles={limits?.maxFiles}
          mentionables={mentionables}
          onSearchFiles={onSearchFiles}
          onSearchCommands={onSearchCommands}
          onOpenPath={onOpenPath}
          threadStatus={t.status}
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
