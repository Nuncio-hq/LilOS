import type { V3Data, V3Settings, V3Thread } from "@lilos/ui"
import type { ReplyFn } from "./chat-sim"

export type SetData = (fn: (d: V3Data) => V3Data) => void

/* What every area of the mock engine needs from the prototype shell: the
   company's records (read now, rewritten through `setData`), the chat
   simulator's reply script, the toast, and the system status dialog the app
   draws beside the shell. */
export type Engine = {
  setData: SetData
  getData: () => V3Data
  reply: ReplyFn
  toast: (t: string) => void
  openStatus: () => void
}

export const ticketPatch = (
  d: V3Data,
  id: string,
  patch: Partial<V3Data["tickets"][number]>,
) => d.tickets.map((t) => (t.id === id ? { ...t, ...patch } : t))

export const threadPatch = (
  d: V3Data,
  pick: (t: V3Thread) => boolean,
  patch: Partial<V3Thread>,
) => d.threads.map((t) => (pick(t) ? { ...t, ...patch } : t))

/** Rewrites Settings' engine connection, where the engine has one. */
export const patchConnect = (
  d: V3Data,
  next: (c: NonNullable<V3Settings["connect"]>) => NonNullable<V3Settings["connect"]>,
): V3Data => (d.settings.connect ? { ...d, settings: { ...d.settings, connect: next(d.settings.connect) } } : d)
