import { agentNameOf, type V3PageProps } from "@lilos/ui"
import { useState } from "react"

/* The thread's browser tab, as a prototype-only stand-in for the desktop
   LilOS Browser (a native page view the web build cannot draw): this thread's
   tabs, the address, the page's text, and Take over / Hand back through the
   mock engine. The real app has no take-over command yet. */

export function MockBrowser({
  data,
  act,
  threadId,
}: Pick<V3PageProps, "data" | "act"> & { threadId: string }) {
  const tabs = data.browser.tabs.filter((b) => b.threadId === threadId)
  const [picked, setPicked] = useState<string>()
  const tab = tabs.find((b) => b.id === picked) ?? tabs[0]
  if (!tab)
    return (
      <p className="p-6 text-[13.5px] text-muted-foreground">
        No pages open in this thread yet.
      </p>
    )
  const agent = tab.by === "you" ? undefined : agentNameOf(data, tab.by)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 border-[var(--v3-line)] border-b px-2 py-1.5">
        {tabs.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => setPicked(b.id)}
            className={`max-w-[180px] truncate rounded-md px-2.5 py-1 text-[12.5px] hover:bg-[var(--v3-hover)] ${b.id === tab.id ? "bg-[var(--v3-soft)] text-foreground" : "text-muted-foreground"}`}
          >
            {b.title}
          </button>
        ))}
      </div>
      <div className="shrink-0 truncate border-[var(--v3-line)] border-b px-4 py-2 font-mono text-[12.5px] text-muted-foreground">
        {tab.url}
      </div>
      {agent && (
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
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4 text-[14px]">
        {(tab.page ?? []).map((line, i) => (
          <p key={line} className={i === 0 ? "font-medium text-[15px]" : "text-muted-foreground"}>
            {line}
          </p>
        ))}
      </div>
    </div>
  )
}
