import { useEffect, useMemo, useState } from "react"
import type { LiveSurfaces } from "@lilos/ui"
import { openViewer, type ViewerHandle } from "@lilos/surfaces"

/* Real-surface attach for the prototype (issue #36): open the prototype with
   ?surfaces=ws://127.0.0.1:PORT&session=<id>&token=<t> and the Workbench
   Terminal/Preview tabs show the harness-owned PTY + browser live, with
   takeover input on the same socket. */
export interface LiveAttach {
  url: string
  token: string
  session: string
}

export function liveAttachFromLocation(): LiveAttach | null {
  const q = new URLSearchParams(window.location.search)
  const url = q.get("surfaces")
  const session = q.get("session")
  const token = q.get("token")
  return url && session && token ? { url, session, token } : null
}

const b64decode = (s: string): string => {
  const bin = atob(s)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function useLiveSurfaces(attach: LiveAttach | null): LiveSurfaces | undefined {
  const [handle, setHandle] = useState<ViewerHandle | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!attach) return
    let cancelled = false
    openViewer({ ...attach, onMessage: () => setTick((n) => n + 1) })
      .then((h) => {
        if (cancelled) h.close()
        else setHandle(h)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      handle?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attach?.url, attach?.session, attach?.token])

  return useMemo(() => {
    if (!handle) return undefined
    const msgs = handle.messages
    const hello = msgs.find((m) => m.type === "hello")
    const frame = [...msgs].reverse().find((m) => m.type === "frame")
    const urlMsg = [...msgs].reverse().find((m) => m.type === "url")
    const previewsMsg = [...msgs].reverse().find((m) => m.type === "previews")
    const activity = msgs
      .filter(
        (m): m is Extract<typeof m, { type: "activity" }> =>
          m.type === "activity",
      )
      .map((m) => ({ tool: m.tool, status: m.status, summary: m.summary, at: m.at }))
    const termText = msgs
      .filter((m): m is Extract<typeof m, { type: "term" }> => m.type === "term")
      .map((m) => b64decode(m.data))
      .join("")
    void tick
    const helloUrl = hello?.type === "hello" ? hello.url : null
    const helloPreviews = hello?.type === "hello" ? hello.previews : []
    return {
      termText,
      terminal: hello?.type === "hello" ? hello.terminal : { cols: 110, rows: 28 },
      frame: frame && frame.type === "frame" ? `data:image/jpeg;base64,${frame.jpeg}` : null,
      page: hello?.type === "hello" ? hello.page : { width: 1280, height: 800 },
      url: urlMsg?.type === "url" ? urlMsg.url : helloUrl,
      previews: previewsMsg?.type === "previews" ? previewsMsg.previews : helloPreviews,
      activity,
      sendInput: (data: string) => handle.send({ type: "term.input", data }),
      resize: (cols: number, rows: number) => handle.send({ type: "term.resize", cols, rows }),
      navigate: (url: string) => handle.send({ type: "browser.navigate", url }),
      input: (evt) => handle.send({ type: "browser.input", event: evt }),
    } satisfies LiveSurfaces
  }, [handle, tick])
}
