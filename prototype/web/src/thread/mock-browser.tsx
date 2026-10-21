import { agentNameOf, type V3PageProps } from "@lilos/ui"
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react"

/* The thread's browser tab, as a prototype-only stand-in for the desktop
   LilOS Browser (a native page view the web build cannot draw): this thread's
   tabs, the address, the page's text, and Take over / Hand back through the
   mock engine. You open a page from the address, add a tab with +, and close
   one with ✕; a control is drawn only when the engine can do it. */

/** Where a browser ends up when you type a bare address. */
const landed = (raw: string) => (/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)

export function MockBrowser({
  data,
  act,
  threadId,
}: Pick<V3PageProps, "data" | "act"> & { threadId: string }) {
  const { browserOpen, browserClose } = act
  const all = data.browser.tabs
  const tabs = useMemo(() => all.filter((b) => b.threadId === threadId), [all, threadId])
  const [picked, setPicked] = useState<string>()
  // The empty tab from +, until you give it an address.
  const [blank, setBlank] = useState(false)
  // What you are typing; unset shows the open tab's own address.
  const [typed, setTyped] = useState<string>()
  const address = useRef<HTMLInputElement>(null)
  // A page you open here becomes the one on show once the engine has added its tab.
  const known = useRef(tabs.length)
  const opening = useRef(false)
  useEffect(() => {
    if (opening.current && tabs.length > known.current) {
      opening.current = false
      setPicked(tabs.at(-1)?.id)
    }
    known.current = tabs.length
  }, [tabs])

  const tab = blank ? undefined : (tabs.find((b) => b.id === picked) ?? tabs[0])
  const agent = tab && tab.by !== "you" ? agentNameOf(data, tab.by) : undefined
  // A page opened or picked comes into view in a strip too narrow for every tab.
  const strip = useRef<HTMLDivElement>(null)
  const shown = tab?.id
  useEffect(() => {
    if (shown) strip.current?.querySelector(`[data-tab="${shown}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest" })
  }, [shown])

  const pick = (id: string) => {
    setPicked(id)
    setBlank(false)
    setTyped(undefined)
  }
  const close = (id: string) => {
    const at = tabs.findIndex((b) => b.id === id)
    browserClose?.(id)
    // The neighbour takes over the view.
    if (id === tab?.id) setPicked((tabs[at + 1] ?? tabs[at - 1])?.id)
  }
  const add = () => {
    setBlank(true)
    setTyped("")
    address.current?.focus()
  }
  const open = (e: FormEvent) => {
    e.preventDefault()
    const text = (typed ?? tab?.url ?? "").trim()
    if (!text || !browserOpen) return
    const url = landed(text)
    const same = tabs.find((b) => b.url === url)
    if (same) pick(same.id)
    else {
      opening.current = true
      setBlank(false)
      setTyped(undefined)
      browserOpen(url, threadId)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-[var(--v3-line)] border-b px-2 py-1.5">
        <div ref={strip} className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {tabs.map((b) => (
            <span
              key={b.id}
              data-tab={b.id}
              className={`flex max-w-[200px] shrink-0 items-center rounded-md ${b.id === tab?.id ? "bg-[var(--v3-soft)] text-foreground" : "text-muted-foreground"}`}
            >
              <button
                type="button"
                onClick={() => pick(b.id)}
                className="min-w-0 truncate rounded-md py-1 pr-1 pl-2.5 text-[12.5px] hover:bg-[var(--v3-hover)]"
              >
                {b.title}
              </button>
              {browserClose && (
                <button
                  type="button"
                  aria-label={`Close ${b.title}`}
                  onClick={() => close(b.id)}
                  className="shrink-0 rounded-md px-1.5 py-1 text-[11px] hover:bg-[var(--v3-hover)]"
                >
                  ✕
                </button>
              )}
            </span>
          ))}
        </div>
        {browserOpen && (
          <button
            type="button"
            aria-label="New tab"
            onClick={add}
            className="shrink-0 rounded-md px-2 py-1 text-[14px] text-muted-foreground hover:bg-[var(--v3-hover)]"
          >
            +
          </button>
        )}
      </div>
      {browserOpen ? (
        <form onSubmit={open} className="shrink-0 border-[var(--v3-line)] border-b px-4 py-2">
          <input
            ref={address}
            aria-label="Address"
            value={typed ?? tab?.url ?? ""}
            onChange={(e) => setTyped(e.target.value)}
            onFocus={(e) => e.target.select()}
            placeholder="Type an address and press Enter"
            spellCheck={false}
            className="w-full bg-transparent font-mono text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </form>
      ) : (
        tab && (
          <div className="shrink-0 truncate border-[var(--v3-line)] border-b px-4 py-2 font-mono text-[12.5px] text-muted-foreground">
            {tab.url}
          </div>
        )
      )}
      {agent && tab && (
        <div className="flex shrink-0 items-center gap-3 border-[var(--v3-line)] border-b px-4 py-2 text-[13px]">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {tab.takenOver
              ? `You have this tab. ${agent} waits.`
              : `${agent} is on this tab${tab.doing ? `: ${tab.doing}` : ""}`}
          </span>
          {act.browserTakeOver && (
            <button
              type="button"
              onClick={() => act.browserTakeOver?.(tab.id)}
              className="shrink-0 rounded-[7px] border border-[var(--v3-line)] px-2.5 py-1 text-[12.5px] hover:bg-[var(--v3-hover)]"
            >
              {tab.takenOver ? "Hand back" : "Take over"}
            </button>
          )}
        </div>
      )}
      {tab ? (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4 text-[14px]">
          {(tab.page ?? []).map((line, i) => (
            <p key={line} className={i === 0 ? "font-medium text-[15px]" : "text-muted-foreground"}>
              {line}
            </p>
          ))}
        </div>
      ) : (
        <p className="p-6 text-[13.5px] text-muted-foreground">
          {blank ? "Type an address above to open a page in this thread." : "No pages open in this thread yet."}
        </p>
      )}
    </div>
  )
}
