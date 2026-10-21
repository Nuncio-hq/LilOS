import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { type ToastNotice, ToastView, type V3Nav, V3Shell, navFromParams, paramsFromNav, paramsText } from "@lilos/ui"
import { V3_DATA, v3Draft } from "./fake-v3"
import { v3Reply } from "./fake-v3-reply"
import { FolderDialog } from "./folder-host"
import { StatusBanner, StatusDetails } from "./status-host"
import { MockThread } from "./thread/mock-thread"
import { type Toast, makeThreadSeams } from "./thread/seams"
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
  const [toast, setToast] = useState<ToastNotice | null>(null)
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
  // With an action ("Undo") the notice stays long enough to use it, and using it clears it.
  const onToast = useCallback<Toast>((text, opts) => {
    const { action } = opts ?? {}
    const notice: ToastNotice = {
      text,
      error: opts?.error,
      action: action && {
        label: action.label,
        run: () => {
          action.run()
          setToast(null)
        },
      },
    }
    setToast(notice)
    window.setTimeout(() => setToast((t) => (t === notice ? null : t)), action ? 10_000 : 2600)
  }, [])
  /* The mock company lives here, beside its engine: the shell is controlled
     (the real app gives it relay data instead). Timers in the chat
     simulator read the latest data through the ref, not a stale closure. */
  const [data, setData] = useState(V3_DATA)
  const dataRef = useRef(data)
  dataRef.current = data
  // The system status and folder dialogs are the app's, beside the shell (the real app hosts them too).
  const [status, setStatus] = useState(false)
  const [asking, setAsking] = useState<((path: string) => void) | null>(null)
  const actions = useMemo(
    () =>
      makeActions({
        setData,
        getData: () => dataRef.current,
        reply: v3Reply,
        toast: onToast,
        openStatus: () => setStatus(true),
        // A function in state: wrapped so React keeps it instead of calling it.
        askForFolder: (onPick) => setAsking(() => onPick),
      }),
    [onToast],
  )
  // What the thread view needs beyond the actions (send with files, edits to the record).
  const seams = useMemo(
    () => makeThreadSeams({ setData, getData: () => dataRef.current, actions, toast: onToast }),
    [actions, onToast],
  )
  return (
    <>
      <V3Shell
        data={data}
        actions={actions}
        nav={nav}
        onNav={setNav}
        draft={v3Draft}
        // The real thread view on mock data; widened, it is the session (chat beside its work).
        renderThread={(p) => (
          <MockThread
            {...p}
            seams={seams}
            session={nav.full === true}
            onSession={(open) => setNav((n) => ({ ...n, full: open }))}
          />
        )}
        banner={<StatusBanner data={data} onDetails={() => setStatus(true)} />}
      />
      {status && <StatusDetails data={data} onClose={() => setStatus(false)} onCopied={() => onToast("Diagnostics copied")} />}
      {asking && <FolderDialog onPick={asking} onClose={() => setAsking(null)} />}
      {toast && <ToastView toast={toast} />}
    </>
  )
}
