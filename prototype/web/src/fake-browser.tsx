import { createContext, useContext, useEffect, useRef, useState } from "react"
import {
  type BrowserBookmark,
  type BrowserDownload,
  type BrowserFind,
  type BrowserHistoryItem,
  type BrowserPanelProps,
  type BrowserTab,
  type Employee,
  LoginSuggestions,
  displayUrl,
  hostOf,
} from "@lilos/ui"
import { cn } from "@lilos/ui/lib/utils"
import { CheckCircle2Icon, CircleDotIcon, MousePointer2Icon, SearchIcon, XCircleIcon } from "lucide-react"

/* Fake LilOS Browser for the prototype (issue #214): canned pages, a fake
   agent driving its own tab, a download in progress and a saved login. The
   real app swaps all of this for a native WebContentsView (#215, #217). */

const SEARCH = "https://www.google.com/search?q="
const PR = "https://github.com/Nuncio-hq/LilOS/pull/207"
const LOGIN = "https://github.com/login"
const DEV = "http://localhost:5173/invoices"
const NEWTAB = "lilos://newtab"

const TITLES: Record<string, string> = {
  [PR]: "Mobile: DM as the employee's thread list · PR #207",
  [LOGIN]: "Sign in to GitHub",
  [DEV]: "Invoices · Acme (dev)",
  [NEWTAB]: "New Tab",
}
const titleOf = (url: string) =>
  TITLES[url] ?? (url.startsWith(SEARCH) ? `${displayUrl(url)} - Search` : hostOf(url).replace(/^www\./, ""))

const BOOKMARKS: BrowserBookmark[] = [
  { url: "https://github.com/Nuncio-hq/LilOS", title: "Nuncio-hq/LilOS" },
  { url: "https://vercel.com/nuncio/lilos-site", title: "lilos-site · Vercel" },
  { url: "https://login.tailscale.com/admin/machines", title: "Machines · Tailscale" },
  { url: "https://hermes-agent.nousresearch.com/docs", title: "Hermes Agent docs" },
  { url: "https://appstoreconnect.apple.com/apps", title: "App Store Connect" },
]

const HISTORY: BrowserHistoryItem[] = [
  { url: PR, title: TITLES[PR], when: "10:42" },
  { url: "https://github.com/Nuncio-hq/LilOS/issues/213", title: "LilOS Browser: Oscar's everyday browser · Issue #213", when: "10:31" },
  { url: "https://vercel.com/nuncio/lilos-site", title: "lilos-site · Vercel", when: "10:05" },
  { url: "https://github.com/Nuncio-hq/LilOS/actions", title: "Actions · Nuncio-hq/LilOS", when: "09:58" },
  { url: "https://login.tailscale.com/admin/machines", title: "Machines · Tailscale", when: "09:40" },
  { url: "https://testflight.apple.com/join/V7FnUmZC", title: "Join the LilOS beta · TestFlight", when: "Yesterday" },
  { url: "https://www.electronjs.org/docs/latest/api/web-contents-view", title: "WebContentsView | Electron", when: "Yesterday" },
  { url: "https://hermes-agent.nousresearch.com/docs", title: "Hermes Agent docs", when: "Yesterday" },
]

/* The fake agent's loop on its tab: what it says it's doing + which element
   on the dev page its pointer sits on. */
const AGENT_STEPS: { action: string; target?: string }[] = [
  { action: "Opening localhost:5173/invoices" },
  { action: "Reading the page", target: "table" },
  { action: "Clicking “New invoice”", target: "new" },
  { action: "Typing “Acme Pty Ltd” into Customer", target: "customer" },
  { action: "Clicking “Save”", target: "save" },
  { action: "Taking a screenshot" },
  { action: "Checking the console · 0 errors" },
]

type FakeTab = BrowserTab & { back: string[]; fwd: string[] }

let seq = 10
const tab = (url: string, agent?: BrowserTab["agent"]): FakeTab => ({ id: `t${++seq}`, url, title: titleOf(url), agent, back: [], fwd: [] })

/* Find-in-page: pages render their text through <T>, which marks matches. */
const FindCtx = createContext("")
function T({ children }: { children: string }) {
  const q = useContext(FindCtx)
  if (!q) return <>{children}</>
  const parts = children.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"))
  return <>{parts.map((s, i) => (i % 2 ? <mark key={i} className="rounded-sm bg-yellow-300 text-black">{s}</mark> : s))}</>
}

export function useFakeBrowser({ employees, say }: { employees: Employee[]; say: (t: string) => void }) {
  const [tabs, setTabs] = useState<FakeTab[]>(() => [
    tab(PR),
    tab(LOGIN),
    tab(DEV, { employeeId: employees[0]?.id ?? "builder", control: "agent", action: AGENT_STEPS[0].action }),
  ])
  const [activeId, setActiveId] = useState(() => tabs[0].id)
  const [history, setHistory] = useState(HISTORY)
  const [bookmarks, setBookmarks] = useState(BOOKMARKS)
  const [downloads, setDownloads] = useState<BrowserDownload[]>([
    { id: "d1", name: "invoices-2026-09.csv", size: "4.2 MB", progress: 0.35 },
    { id: "d2", name: "LilOS-1.0.23.dmg", size: "142 MB", when: "Today 09:12" },
  ])
  const [zoom, setZoom] = useState(1)
  const [find, setFind] = useState<BrowserFind | null>(null)
  const [findCount, setFindCount] = useState(0)
  const [step, setStep] = useState(0)
  const [login, setLogin] = useState<{ focused: boolean; filled: boolean }>({ focused: true, filled: false })
  const pageRef = useRef<HTMLDivElement>(null)
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]

  // The fake agent keeps working on every tab it drives.
  useEffect(() => {
    const id = setInterval(() => setStep((s) => s + 1), 2200)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    setTabs((ts) => ts.map((t) => (t.agent?.control === "agent" ? { ...t, agent: { ...t.agent, action: t.url === DEV ? AGENT_STEPS[step % AGENT_STEPS.length].action : ["Reading the page", "Scrolling down", "Taking a screenshot"][step % 3] } } : t)))
  }, [step])

  // The in-progress download finishes on its own.
  useEffect(() => {
    const id = setInterval(() => setDownloads((ds) => ds.map((d) => (d.progress === undefined ? d : d.progress >= 0.95 ? { id: d.id, name: d.name, size: d.size, when: "Just now" } : { ...d, progress: d.progress + 0.05 }))), 700)
    return () => clearInterval(id)
  }, [])

  // Match count + current match come from the rendered page.
  useEffect(() => {
    const marks = pageRef.current?.querySelectorAll("mark") ?? []
    setFindCount(marks.length)
    marks.forEach((m, i) => m.classList.toggle("!bg-orange-400", i === find?.index))
    marks[find?.index ?? 0]?.scrollIntoView({ block: "center" })
  }, [find, activeId, active?.url])

  const patch = (id: string, fn: (t: FakeTab) => FakeTab) => setTabs((ts) => ts.map((t) => (t.id === id ? fn(t) : t)))
  const load = (id: string, url: string, push: "back" | "fwd" | null) => {
    patch(id, (t) => ({
      ...t, url, title: titleOf(url), loading: true,
      back: push === "back" ? [...t.back, t.url] : push === "fwd" ? t.back.slice(0, -1) : t.back,
      fwd: push === "back" ? [] : push === "fwd" ? [t.url, ...t.fwd] : t.fwd.slice(1),
    }))
    setTimeout(() => patch(id, (t) => ({ ...t, loading: false })), 450)
    if (!url.startsWith("lilos://")) setHistory((h) => [{ url, title: titleOf(url), when: "Now" }, ...h.filter((x) => x.url !== url)])
  }

  const props: Omit<BrowserPanelProps, "mode" | "onMode" | "onClose" | "page"> = {
    tabs, activeId: active.id, emp: (id) => employees.find((e) => e.id === id), employees,
    history, bookmarks, downloads,
    canBack: active.back.length > 0, canForward: active.fwd.length > 0,
    zoom, find, findCount, onFind: setFind,
    onSelectTab: setActiveId,
    onNewTab: () => { const t = tab(NEWTAB); setTabs((ts) => [...ts, t]); setActiveId(t.id) },
    onCloseTab: (id) => setTabs((ts) => {
      const next = ts.filter((t) => t.id !== id)
      if (next.length === 0) { const t = tab(NEWTAB); setActiveId(t.id); return [t] }
      if (id === activeId) setActiveId(next[Math.max(0, ts.findIndex((t) => t.id === id) - 1)].id)
      return next
    }),
    onNavigate: (url) => load(active.id, url, "back"),
    onBack: () => active.back.length && load(active.id, active.back[active.back.length - 1], "fwd"),
    onForward: () => active.fwd.length && load(active.id, active.fwd[0], null),
    onReload: () => { patch(active.id, (t) => ({ ...t, loading: true })); setTimeout(() => patch(active.id, (t) => ({ ...t, loading: false })), 450) },
    onZoom: setZoom,
    onToggleBookmark: () => setBookmarks((b) => (b.some((x) => x.url === active.url) ? b.filter((x) => x.url !== active.url) : [{ url: active.url, title: active.title }, ...b])),
    onPrint: () => say("Print dialog opens (macOS)"),
    onDevTools: () => say("DevTools opens for this tab"),
    onTakeControl: (id) => patch(id, (t) => ({ ...t, agent: t.agent && { ...t.agent, control: "you" } })),
    onHandBack: (id) => patch(id, (t) => ({ ...t, agent: t.agent && { ...t.agent, control: "agent", action: "Picking up where it left off" } })),
    onHandTo: (id, employeeId) => {
      patch(id, (t) => ({ ...t, agent: { employeeId, control: "agent", action: "Reading the page" } }))
      say(`${employees.find((e) => e.id === employeeId)?.name} now has this tab`)
    },
    onClearHistory: () => setHistory([]),
    onRemoveBookmark: (url) => setBookmarks((b) => b.filter((x) => x.url !== url)),
    onShowDownload: () => say("Revealed in Finder"),
  }

  const agentOn = active.agent?.control === "agent"
  const target = active.url === DEV && agentOn ? AGENT_STEPS[step % AGENT_STEPS.length].target : undefined
  const page = (
    <FindCtx.Provider value={find?.query ?? ""}>
      <div ref={pageRef} data-fake-page={active.url} className={cn("min-h-full bg-white text-[14px] text-zinc-900 [&_*]:border-zinc-200", active.loading && "opacity-60")} style={{ zoom }}>
        {active.url === NEWTAB ? <NewTabPage bookmarks={bookmarks} onGo={props.onNavigate} />
          : active.url === PR ? <PrPage />
          : active.url === LOGIN ? <LoginPage login={login} setLogin={setLogin} />
          : active.url === DEV ? <DevPage target={target} customer={agentOn && step % AGENT_STEPS.length >= 3} />
          : active.url.startsWith(SEARCH) ? <SearchPage q={displayUrl(active.url)} onGo={props.onNavigate} />
          : <GenericPage url={active.url} />}
      </div>
    </FindCtx.Provider>
  )
  return { props, page }
}

function NewTabPage({ bookmarks, onGo }: { bookmarks: BrowserBookmark[]; onGo: (u: string) => void }) {
  return (
    <div className="flex min-h-full flex-col items-center bg-zinc-50 px-6 pt-24">
      <div className="mb-8 font-semibold text-3xl tracking-tight">LilOS</div>
      <form className="flex w-full max-w-md items-center gap-2 rounded-full border bg-white px-4 py-2.5 shadow-sm" onSubmit={(e) => { e.preventDefault(); const q = new FormData(e.currentTarget).get("q"); if (q) onGo(SEARCH + encodeURIComponent(String(q))) }}>
        <SearchIcon className="size-4 text-zinc-400" />
        <input name="q" placeholder="Search the web" className="flex-1 bg-transparent outline-none" />
      </form>
      <div className="mt-10 grid w-full max-w-md grid-cols-4 gap-3">
        {bookmarks.slice(0, 8).map((b) => (
          <button key={b.url} onClick={() => onGo(b.url)} className="flex flex-col items-center gap-2 rounded-xl p-2 hover:bg-zinc-100">
            <span className="grid size-10 place-items-center rounded-full bg-white font-semibold shadow-sm ring-1 ring-zinc-200">{hostOf(b.url).replace(/^(www|login)\./, "")[0].toUpperCase()}</span>
            <span className="w-full truncate text-center text-xs">{b.title}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function PrPage() {
  const checks: [string, "ok" | "fail" | "run"][] = [["verify / biome + typecheck", "ok"], ["verify / unit", "ok"], ["e2e (Linux)", "run"], ["DCO", "ok"]]
  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <div className="text-xs text-zinc-500"><T>Nuncio-hq / LilOS · Pull requests</T></div>
      <h1 className="mt-2 font-semibold text-2xl"><T>Mobile: DM as the employee's thread list (Needs you / Working / Done) + new thread</T> <span className="font-normal text-zinc-400">#207</span></h1>
      <div className="mt-3 flex items-center gap-2 text-sm"><span className="rounded-full bg-zinc-500 px-2.5 py-0.5 text-white">Draft</span><span className="text-zinc-600"><T>devin wants to merge 9 commits into main from devin/156-mobile-dm</T></span></div>
      <div className="mt-6 rounded-lg border">
        <div className="border-b bg-zinc-50 px-4 py-2 font-medium text-sm">Checks</div>
        {checks.map(([name, s]) => (
          <div key={name} className="flex items-center gap-2 border-b px-4 py-2 text-sm last:border-0">
            {s === "ok" ? <CheckCircle2Icon className="size-4 text-green-600" /> : s === "fail" ? <XCircleIcon className="size-4 text-red-600" /> : <CircleDotIcon className="size-4 animate-pulse text-amber-500" />}
            <T>{name}</T>
          </div>
        ))}
      </div>
      <div className="mt-6 space-y-3 text-sm leading-relaxed text-zinc-700">
        <p><T>The DM opens as the employee's thread list, grouped by state: Needs you, Working, Done. A new thread starts from the composer at the bottom.</T></p>
        <p><T>How to try it: open the iPhone app, pick an employee, and start a new thread. Screenshots per acceptance criterion are below.</T></p>
      </div>
    </div>
  )
}

function LoginPage({ login, setLogin }: { login: { focused: boolean; filled: boolean }; setLogin: (l: { focused: boolean; filled: boolean }) => void }) {
  return (
    <div className="flex min-h-full flex-col items-center bg-zinc-50 pt-16">
      <div className="grid size-12 place-items-center rounded-full bg-zinc-900 font-bold text-white">G</div>
      <h1 className="mt-4 font-light text-2xl"><T>Sign in to GitHub</T></h1>
      <div className="mt-6 w-80 space-y-3 rounded-lg border bg-white p-5">
        <label className="block text-sm"><T>Username or email address</T>
          <div className="relative">
            <input value={login.filled ? "oscarlehuu" : ""} readOnly onFocus={() => setLogin({ ...login, focused: true })} onBlur={() => setLogin({ ...login, focused: false })}
              className={cn("mt-1 w-full rounded-md border px-2 py-1.5 outline-none", login.focused && "ring-2 ring-blue-500", login.filled && "bg-blue-50")} />
            {login.focused && !login.filled && (
              <div className="absolute top-full left-0 z-10 mt-1">
                <LoginSuggestions site="github.com" logins={[{ id: "l1", username: "oscarlehuu" }, { id: "l2", username: "oscar@nuncio.dev" }]} onPick={() => setLogin({ focused: false, filled: true })} onManage={() => {}} />
              </div>
            )}
          </div>
        </label>
        <label className="block text-sm"><T>Password</T>
          <input type="password" value={login.filled ? "••••••••••••" : ""} readOnly className={cn("mt-1 w-full rounded-md border px-2 py-1.5", login.filled && "bg-blue-50")} />
        </label>
        <button className="w-full rounded-md bg-green-600 py-1.5 font-medium text-white">Sign in</button>
      </div>
    </div>
  )
}

function DevPage({ target, customer }: { target?: string; customer: boolean }) {
  const ring = (id: string) => target === id && "relative outline outline-2 outline-offset-2 outline-violet-500"
  const Pointer = ({ id }: { id: string }) => target === id ? <MousePointer2Icon className="absolute -right-3 -bottom-4 z-10 size-5 fill-violet-600 text-white drop-shadow" /> : null
  const rows: [string, string, string][] = [["INV-1042", "Northwind Traders", "$2,400.00"], ["INV-1041", "Globex", "$980.00"], ["INV-1040", "Initech", "$12,150.00"], ["INV-1039", "Umbrella Co", "$640.00"]]
  return (
    <div className="px-6 py-5">
      <div className="flex items-center justify-between">
        <h1 className="font-semibold text-xl"><T>Invoices</T></h1>
        <button className={cn("rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white", ring("new"))}>+ <T>New invoice</T><Pointer id="new" /></button>
      </div>
      <div className="mt-4 grid grid-cols-[1fr_auto] items-end gap-3 rounded-lg border p-4">
        <label className="text-sm"><T>Customer</T>
          <div className={cn("mt-1 rounded-md border px-2 py-1.5", ring("customer"))}>{customer ? "Acme Pty Ltd" : <span className="text-zinc-400">Customer name</span>}<Pointer id="customer" /></div>
        </label>
        <button className={cn("rounded-md border px-3 py-1.5 text-sm", ring("save"))}><T>Save</T><Pointer id="save" /></button>
      </div>
      <table className={cn("mt-5 w-full text-sm", ring("table"))}>
        <thead className="text-left text-zinc-500"><tr><th className="py-2 font-medium">Number</th><th className="font-medium">Customer</th><th className="text-right font-medium">Amount</th></tr></thead>
        <tbody>{rows.map(([n, c, a]) => <tr key={n} className="border-t"><td className="py-2 font-mono text-xs">{n}</td><td><T>{c}</T></td><td className="text-right tabular-nums">{a}</td></tr>)}</tbody>
      </table>
      <Pointer id="table" />
    </div>
  )
}

function SearchPage({ q, onGo }: { q: string; onGo: (u: string) => void }) {
  const results = [
    { url: "https://www.electronjs.org/docs/latest/api/web-contents-view", title: "WebContentsView | Electron", text: "A WebContentsView displays a WebContents in a BaseWindow. It is how an Electron app embeds a real page." },
    { url: "https://chromedevtools.github.io/devtools-protocol/", title: "Chrome DevTools Protocol", text: "The protocol lets tools instrument, inspect, debug and profile Chromium: Input, Page, Runtime, Network." },
    { url: "https://github.com/Nuncio-hq/LilOS/issues/213", title: "LilOS Browser: Oscar's everyday browser, shared with agents", text: "⌘⇧B opens the LilOS Browser: a panel beside the chat that can pop out into its own window." },
  ]
  return (
    <div className="max-w-2xl px-8 py-6">
      <div className="mb-5 text-sm text-zinc-500">Results for “<T>{q}</T>”</div>
      {results.map((r) => (
        <div key={r.url} className="mb-6">
          <div className="text-xs text-zinc-500">{displayUrl(r.url)}</div>
          <button onClick={() => onGo(r.url)} className="text-left text-lg text-blue-700 hover:underline"><T>{r.title}</T></button>
          <p className="text-sm text-zinc-600"><T>{r.text}</T></p>
        </div>
      ))}
    </div>
  )
}

function GenericPage({ url }: { url: string }) {
  return (
    <div className="mx-auto max-w-2xl px-8 py-16">
      <div className="text-xs text-zinc-500">{hostOf(url)}</div>
      <h1 className="mt-2 font-semibold text-3xl"><T>{titleOf(url)}</T></h1>
      <p className="mt-4 text-zinc-600"><T>A real page renders here in LilOS.app. The prototype shows a placeholder for addresses it has no canned page for.</T></p>
    </div>
  )
}
