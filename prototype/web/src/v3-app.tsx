import { useCallback, useEffect, useState } from "react"
import { type V3Nav, type V3PageRoute, type V3RecordRoute, V3Shell } from "@lilos/ui"
import { V3_DATA, v3Draft } from "./fake-v3"
import { v3Reply } from "./fake-v3-reply"

const PAGES = [
  "home",
  "needs",
  "inbox",
  "work",
  "threads",
  "goals",
  "people",
  "hire",
  "guide",
  "settings",
  "welcome",
] as const
const RECORDS = ["ticket", "thread", "goal", "project", "agent", "newchat"] as const

/* Where a bare record link lands: the page that lists it. */
const HOME_OF: Record<(typeof RECORDS)[number], V3PageRoute["page"]> = {
  ticket: "work",
  thread: "threads",
  newchat: "threads",
  agent: "people",
  goal: "goals",
  project: "home",
}

/* ?v3 entry: the calm-company prototype. The URL mirrors where you are, so
   any screen can be linked, reloaded, or reached with Back/Forward:
   ?v3&page=threads&open=thread:t-lil81,ticket:LIL-81 (a page, plus the trail
   open in the side peek) · &full=1 widens the peek (a thread becomes a
   session: chat left, its work right) · ?v3&page=work&view=board ·
   ?v3&page=settings&view=phone · ?v3&page=welcome (first run) ·
   ?v3&page=people&open=agent:scout,newchat:scout · &theme=dark|light. A bare record link
   (?v3&page=ticket&id=HB-12) opens it over the page that lists it. The mock
   company state lives in the shell and resets only on a full reload. */
function navFromUrl(): V3Nav {
  const q = new URLSearchParams(location.search)
  const name = q.get("page") ?? "home"
  const view = q.get("view") ?? undefined
  const peek: V3RecordRoute[] = (q.get("open") ?? "")
    .split(",")
    .map((s) => s.split(":"))
    .filter(([p, id]) => id && RECORDS.includes(p as (typeof RECORDS)[number]))
    .map(([p, id]) => ({ page: p, id }) as V3RecordRoute)
  const full = q.get("full") === "1"
  const id = q.get("id")
  if (RECORDS.includes(name as (typeof RECORDS)[number]) && id) {
    const r = { page: name, id } as V3RecordRoute
    return { page: { page: HOME_OF[r.page] } as V3PageRoute, peek: [r], full }
  }
  if (!PAGES.includes(name as (typeof PAGES)[number])) return { page: { page: "home" }, peek }
  return { page: { page: name, view } as V3PageRoute, peek, full }
}

function urlFromNav(n: V3Nav) {
  const q = new URLSearchParams(location.search)
  for (const k of ["page", "id", "view", "open", "full"]) q.delete(k)
  const p = n.page
  if (p.page !== "home") q.set("page", p.page)
  if ("view" in p && p.view) q.set("view", p.view)
  if (n.peek.length) q.set("open", n.peek.map((r) => `${r.page}:${r.id}`).join(","))
  if (n.full && n.peek.length) q.set("full", "1")
  return `?${q.toString().replace(/^v3=(&|$)/, "v3$1").replaceAll("%3A", ":").replaceAll("%2C", ",")}`
}

/* &theme= pins the theme before the shell's theme hook first reads it. */
const pinned = new URLSearchParams(location.search).get("theme")
if (pinned === "dark" || pinned === "light") localStorage.setItem("lilos-theme", pinned)

export default function V3App() {
  const [toast, setToast] = useState<string | null>(null)
  const [nav, setNav] = useState(navFromUrl)
  // Every move becomes a history entry; Back/Forward read it back.
  useEffect(() => {
    const url = urlFromNav(nav)
    if (url !== location.search) history.pushState(null, "", url)
  }, [nav])
  useEffect(() => {
    const onPop = () => setNav(navFromUrl())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])
  const onToast = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast((t) => (t === text ? null : t)), 2600)
  }, [])
  return (
    <>
      <V3Shell initial={V3_DATA} nav={nav} onNav={setNav} draft={v3Draft} reply={v3Reply} onToast={onToast} />
      {toast && (
        <div className="lilos-rise fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-[13px] text-background shadow-lg">
          {toast}
        </div>
      )}
    </>
  )
}
