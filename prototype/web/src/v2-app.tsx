import { useEffect, useState } from "react"
import { useTheme, V2Shell } from "@lilos/ui"
import { V2_ACTIVITY, V2_AGENTS, V2_MODELS, V2_PROJECTS, v2Threads } from "./fake-v2"

/* ?v2 entry: the UX v2 prototype on its own, so the current app stays
   untouched while Oscar judges the new layout. ?v2&n=300 loads more history;
   ?v2&theme=dark|light pins the theme; &thread=<id> opens a thread. */
export default function V2App() {
  const params = new URLSearchParams(location.search)
  const total = Math.max(15, Number(params.get("n") ?? 60))
  const pinned = params.get("theme")
  const [, setTheme] = useTheme()
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (pinned === "dark" || pinned === "light") setTheme(pinned)
  }, [pinned, setTheme])
  return (
    <>
      <V2Shell
        company="Oscar Co"
        projects={V2_PROJECTS}
        agents={V2_AGENTS}
        models={V2_MODELS}
        initialThreads={v2Threads(total)}
        initialThreadId={params.get("thread") ?? undefined}
        activity={V2_ACTIVITY}
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
