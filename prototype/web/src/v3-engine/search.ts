import type { V3DataActions, V3MessageHit, V3Thread } from "@lilos/ui"
import { fakeCommands, fakeFiles } from "../fake-v3-mentions"
import type { Engine } from "./context"

/* Rows the mock ⌘K search returns at most (the relay's own cap). */
const MAX_HITS = 50
const BEFORE = 50
const AFTER = 90

/** An excerpt of `text` around the first word that matched, with `<mark>`
    around every matched word in it (the relay's snippet shape). Emphasis and
    code marks are dropped: the excerpt reads as plain text. */
function snippetOf(text: string, words: string[]): string {
  const plain = text.replace(/[*`]/g, "").replace(/\s+/g, " ").trim()
  const at = plain.toLowerCase().indexOf(words[0])
  const from = Math.max(0, at - BEFORE)
  const part = plain.slice(from, from + BEFORE + AFTER)
  const marked = part.replace(new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi"), "<mark>$&</mark>")
  return `${from > 0 ? "…" : ""}${marked}${from + part.length < plain.length ? "…" : ""}`
}

/** What was said in `thread` that holds every word (like the relay's index:
    visible message text only, never steps or tool output). */
function hitsIn(thread: V3Thread, words: string[]): V3MessageHit[] {
  return thread.turns.flatMap((turn) => {
    const said = [
      turn.prompt && { id: "prompt", by: turn.prompt.by, at: turn.prompt.at, text: turn.prompt.text },
      turn.answer && { id: "answer", by: thread.agentId, at: turn.prompt?.at ?? thread.startedAt, text: turn.answer },
    ]
    return said.flatMap((m) =>
      m && words.every((w) => m.text.toLowerCase().includes(w))
        ? [{ messageId: `${thread.id}:${turn.n}:${m.id}`, threadId: thread.id, by: m.by, at: m.at, snippet: snippetOf(m.text, words) }]
        : [],
    )
  })
}

/* What a new chat's `@` and `/` read, and ⌘K's message search: the mock
   company's own threads (archived ones too) and the engine's small catalog. */
export function searchActions({ getData }: Engine): Pick<
  V3DataActions,
  "searchMessages" | "searchFiles" | "searchCommands"
> {
  return {
    searchMessages: (query) => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean)
      if (words.length === 0) return Promise.resolve([])
      const d = getData()
      return Promise.resolve([...d.threads, ...(d.archivedThreads ?? [])].flatMap((t) => hitsIn(t, words)).slice(0, MAX_HITS))
    },
    searchFiles: (folder, query) => Promise.resolve(fakeFiles(folder, query)),
    searchCommands: ({ agentId }, query) => Promise.resolve(fakeCommands(getData(), agentId, query)),
  }
}
