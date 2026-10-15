import { useEffect, useMemo, useState } from "react"
import { type ModelVisibility, useTheme, V2Shell } from "@lilos/ui"
import {
  V2_ACTIVITY,
  V2_AGENTS,
  V2_DISCOVERED,
  V2_FS,
  V2_MODEL_OPTIONS,
  V2_PROJECTS,
  V2_PROVIDERS,
  v2Threads,
} from "./fake-v2"
import { V2_CEO_THREAD, V2_CEO_THREAD_OLD, V2_CONNECTORS, V2_GOALS, V2_TICKETS } from "./fake-v2-work"

const SHEETS = ["agents", "hire", "needs", "working", "settings", "connectors"] as const
type SheetParam = (typeof SHEETS)[number]

/* ?v2 entry: the UX v2 prototype on its own, so the current app stays
   untouched while Oscar judges the new layout. ?v2&n=300 loads more history;
   ?v2&theme=dark|light pins the theme; &thread=<id> opens a thread;
   &sheet=agents|hire|needs|working|settings|connectors opens a side sheet;
   &view=work opens the Work board; &ceo opens the CEO beside it; &ticket=<id>
   opens a ticket's live trail. */
export default function V2App() {
  const params = new URLSearchParams(location.search)
  const total = Math.max(15, Number(params.get("n") ?? 60))
  const pinned = params.get("theme")
  const sheetParam = params.get("sheet")
  const ticketParam = params.get("ticket")
  const sheet = ticketParam
    ? { ticket: ticketParam }
    : SHEETS.includes(sheetParam as SheetParam)
      ? (sheetParam as SheetParam)
      : undefined
  const [, setTheme] = useTheme()
  const [toast, setToast] = useState<string | null>(null)
  const [visibility, setVisibility] = useState<ModelVisibility>({ providers: [], models: [] })
  const threads = useMemo(() => [V2_CEO_THREAD, V2_CEO_THREAD_OLD, ...v2Threads(total)], [total])
  useEffect(() => {
    if (pinned === "dark" || pinned === "light") setTheme(pinned)
  }, [pinned, setTheme])
  return (
    <>
      <V2Shell
        company="Oscar Co"
        me="Oscar"
        projects={V2_PROJECTS}
        agents={V2_AGENTS}
        modelKit={{ models: V2_MODEL_OPTIONS, providers: V2_PROVIDERS, visibility, onVisibility: setVisibility }}
        fs={V2_FS}
        discovered={V2_DISCOVERED}
        initialThreads={threads}
        initialThreadId={params.get("thread") ?? undefined}
        initialSheet={sheet}
        initialView={params.get("view") === "work" || ticketParam ? "work" : undefined}
        initialCeo={params.has("ceo")}
        activity={V2_ACTIVITY}
        goals={V2_GOALS}
        tickets={V2_TICKETS}
        connectors={V2_CONNECTORS}
        onToast={(text) => {
          setToast(text)
          window.setTimeout(() => setToast((t) => (t === text ? null : t)), 2400)
        }}
      />
      {toast && (
        <div className="lilos-rise fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-[13px] text-background shadow-lg">
          {toast}
        </div>
      )}
    </>
  )
}
