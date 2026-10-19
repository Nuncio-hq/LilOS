import { useCallback, useEffect, useState } from "react"
import { type V3Route, V3Shell } from "@lilos/ui"
import { V3_DATA, v3Draft } from "./fake-v3"

const PAGES = [
  "home",
  "needs",
  "inbox",
  "work",
  "ticket",
  "threads",
  "thread",
  "goals",
  "goal",
  "project",
  "people",
  "agent",
  "hire",
  "guide",
] as const

/* ?v3 entry: the calm-company prototype (Notion-like: People, Work, Goals).
   The URL mirrors the page so any screen can be linked, reloaded, or reached
   with Back/Forward: ?v3&page=ticket&id=HB-12 · ?v3&page=work&view=board ·
   &theme=dark|light. The mock company state lives in the shell and resets
   only on a full reload. */
function routeFromUrl(): V3Route {
  const q = new URLSearchParams(location.search)
  const page = q.get("page") ?? "home"
  const id = q.get("id") ?? ""
  const view = q.get("view") ?? undefined
  if (!PAGES.includes(page as (typeof PAGES)[number])) return { page: "home" }
  if (page === "ticket" || page === "thread" || page === "goal" || page === "project" || page === "agent")
    return id ? ({ page, id } as V3Route) : { page: "home" }
  if (page === "work" || page === "threads" || page === "people") return { page, view } as V3Route
  return { page } as V3Route
}

function urlFromRoute(r: V3Route) {
  const q = new URLSearchParams(location.search)
  for (const k of ["page", "id", "view"]) q.delete(k)
  if (r.page !== "home") q.set("page", r.page)
  if ("id" in r) q.set("id", r.id)
  if ("view" in r && r.view) q.set("view", r.view)
  return `?${q.toString().replace(/^v3=(&|$)/, "v3$1")}`
}

/* &theme= pins the theme before the shell's theme hook first reads it. */
const pinned = new URLSearchParams(location.search).get("theme")
if (pinned === "dark" || pinned === "light") localStorage.setItem("lilos-theme", pinned)

export default function V3App() {
  const [toast, setToast] = useState<string | null>(null)
  const [route, setRoute] = useState(routeFromUrl)
  useEffect(() => {
    const onPop = () => setRoute(routeFromUrl())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])
  const onRoute = useCallback((r: V3Route) => {
    history.pushState(null, "", urlFromRoute(r))
    setRoute(r)
  }, [])
  const onToast = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast((t) => (t === text ? null : t)), 2600)
  }, [])
  return (
    <>
      <V3Shell initial={V3_DATA} route={route} onRoute={onRoute} draft={v3Draft} onToast={onToast} />
      {toast && (
        <div className="lilos-rise fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-[13px] text-background shadow-lg">
          {toast}
        </div>
      )}
    </>
  )
}
