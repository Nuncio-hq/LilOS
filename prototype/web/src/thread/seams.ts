import type { AttachedFile, V3Data, V3DataActions, V3Thread } from "@lilos/ui"
import { runTurn } from "../v3-engine/chat-sim"
import { v3Reply } from "../fake-v3-reply"

/** A one-line notice. `error` gives it the destructive accent; one `action` ("Undo") keeps it up 10 s instead of 2.6 s. */
export type ToastAction = { label: string; run: () => void }
export type Toast = (text: string, opts?: { error?: boolean; action?: ToastAction }) => void

/* What the mock thread view needs beyond the shell's actions: sending with
   attachments (the shell's `message` carries text only), small edits to the
   thread record (model pick, compaction, a queued message taken back, a plan
   decided), and the one-line notices. Backed by the same mock engine as
   everything else. */
export type ThreadSeams = {
  toast: Toast
  send: (threadId: string, text: string, files?: AttachedFile[]) => void
  patch: (threadId: string, fn: (t: V3Thread) => V3Thread) => void
}

export function makeThreadSeams(engine: {
  setData: (fn: (d: V3Data) => V3Data) => void
  getData: () => V3Data
  actions: V3DataActions
  toast: Toast
}): ThreadSeams {
  const { setData, getData, actions, toast } = engine
  return {
    toast,
    send: (id, text, files) => {
      const th = getData().threads.find((t) => t.id === id)
      if (!th) return
      // A working thread queues the message; an idle one starts its next turn.
      if (th.status === "working") actions.message(id, text)
      else runTurn(setData, getData, v3Reply, th, text, files)
    },
    patch: (id, fn) =>
      setData((d) => ({
        ...d,
        threads: d.threads.map((t) => (t.id === id ? fn(t) : t)),
        archivedThreads: d.archivedThreads?.map((t) => (t.id === id ? fn(t) : t)),
      })),
  }
}
