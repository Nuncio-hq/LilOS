import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { type V3Nav, V3Shell, navFromParams, paramsFromNav, paramsText } from "@lilos/ui"
import { V3_DATA, v3Draft } from "./fake-v3"
import { v3Reply } from "./fake-v3-reply"
import { makeActions } from "./v3-engine/actions"

/* The prototype's one screen: the calm company. The URL mirrors where you
   are, so any screen can be linked, reloaded, or reached with Back/Forward:
   /?page=threads&open=thread:t-lil81,ticket:LIL-81 (a page, plus the trail
   open in the side peek) · &full=1 widens the peek (a thread becomes a
   session: chat left, its work right) · /?page=work&view=board ·
   /?page=settings&view=phone · /?page=welcome (first run) ·
   /?page=people&open=agent:scout,newchat:scout · &theme=dark|light. A bare record link
   (/?page=ticket&id=HB-12) opens it over the page that lists it. A leading
   `v3` flag (old links: ?v3&page=…) is the same screen and is kept as is.
   The mock company state lives in the shell and resets only on a full reload. */
const navFromUrl = (): V3Nav => navFromParams(new URLSearchParams(location.search))

/* The query string for a nav: empty at Home, so a bare `/` stays bare. */
function searchFromNav(n: V3Nav) {
  const text = paramsText(paramsFromNav(n, new URLSearchParams(location.search)))
  return text ? `?${text.replace(/(^|&)v3=(?=&|$)/, "$1v3")}` : ""
}

/* &theme= pins the theme before the shell's theme hook first reads it. */
const pinned = new URLSearchParams(location.search).get("theme")
if (pinned === "dark" || pinned === "light") localStorage.setItem("lilos-theme", pinned)

export default function V3App() {
  const [toast, setToast] = useState<string | null>(null)
  const [nav, setNav] = useState(navFromUrl)
  // Every move becomes a history entry; Back/Forward read it back.
  useEffect(() => {
    const search = searchFromNav(nav)
    // An empty search has to name the path: pushState("") keeps the current query.
    if (search !== location.search) history.pushState(null, "", search || location.pathname)
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
  /* The mock company lives here, beside its engine: the shell is controlled
     (the real app gives it relay data instead). Timers in the chat
     simulator read the latest data through the ref, not a stale closure. */
  const [data, setData] = useState(V3_DATA)
  const dataRef = useRef(data)
  dataRef.current = data
  const actions = useMemo(() => makeActions(setData, () => dataRef.current, v3Reply, onToast), [onToast])
  return (
    <>
      <V3Shell data={data} actions={actions} nav={nav} onNav={setNav} draft={v3Draft} />
      {toast && (
        <div className="lilos-rise fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-[13px] text-background shadow-lg">
          {toast}
        </div>
      )}
    </>
  )
}
