import { useMemo, useRef, useState } from "react"
import type { LiveSurfaces } from "@lilos/ui"

/* Prototype fake for the live Workbench surfaces (issues #36, #56): a canned
   PTY session and a canvas-drawn "page" standing in for the harness
   screencast. sendInput echoes like a shell — and, like the real surfaces,
   the first keystroke takes the terminal from the agent (termControl
   "user") until "Return control"; navigate lands on the canonical URL like
   a real browser does after redirects; resizeBrowser repaints the page at
   the pane's pixels so the preview fits without letterbox bars. */
const BANNER = [
  "\u001b[90m$ \u001b[0mbun dev",
  "\u001b[36mvite\u001b[0m v6 ready in 212 ms",
  "\u001b[32m➜\u001b[0m  Local:   http://localhost:5173/",
  "PREVIEW: http://localhost:5173/",
  "",
  // Real zsh prompts redraw the line with `\r` over a run of pad spaces —
  // kept verbatim so the fake renders like the live PTY does.
  `${" ".repeat(64)}\r\u001b[90m$ \u001b[0m`,
].join("\r\n")

function drawFrame(url: string, clicks: number, w: number, h: number): string {
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  const g = c.getContext("2d")!
  const grad = g.createLinearGradient(0, 0, w, h)
  grad.addColorStop(0, "#0c4a6e")
  grad.addColorStop(1, "#115e59")
  g.fillStyle = grad
  g.fillRect(0, 0, w, h)
  const s = Math.max(0.4, Math.min(w / 1280, h / 800))
  g.fillStyle = "#f8fafc"
  g.font = `bold ${Math.round(64 * s)}px system-ui`
  g.fillText("Acme Storefront", 80 * s, 160 * s)
  g.font = `${Math.round(28 * s)}px system-ui`
  g.fillStyle = "#a5f3fc"
  g.fillText(url, 80 * s, 220 * s)
  g.fillStyle = "#f8fafc"
  g.fillRect(80 * s, 300 * s, 260 * s, 72 * s)
  g.fillStyle = "#0f172a"
  g.font = `bold ${Math.round(26 * s)}px system-ui`
  g.fillText("Shop now", 140 * s, 344 * s)
  g.fillStyle = "#99f6e4"
  g.font = `${Math.round(22 * s)}px system-ui`
  g.fillText(`agent clicks: ${clicks}`, 80 * s, 430 * s)
  return c.toDataURL("image/jpeg", 0.7)
}

/** Where a real browser ends up: scheme filled in, canonical origin + path. */
function landed(raw: string): string {
  try {
    return new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).href
  } catch {
    return raw
  }
}

export function useFakeSurfaces(enabled: boolean): LiveSurfaces | undefined {
  const [termText, setTermText] = useState(BANNER)
  const [termControl, setTermControl] = useState<"agent" | "user">("agent")
  const [frame, setFrame] = useState<string | null>(null)
  const [page, setPage] = useState({ width: 1280, height: 800 })
  const [url, setUrl] = useState<string | null>(null)
  const buf = useRef("")
  const clicks = useRef(0)
  return useMemo(() => {
    if (!enabled) return undefined
    const answer = (line: string): string => {
      const cmd = line.trim()
      if (cmd === "" ) return ""
      if (cmd.startsWith("echo ")) return cmd.slice(5)
      if (cmd === "ls") return "src  package.json  public  index.html"
      if (cmd === "help") return "fake shell: echo · ls · open <url>"
      if (cmd.startsWith("open ")) {
        const u = landed(cmd.slice(5).trim())
        setUrl(u)
        setFrame(drawFrame(u, clicks.current, page.width, page.height))
        return `opened ${u}`
      }
      return `${cmd}: command not found`
    }
    return {
      termText,
      terminal: { cols: 80, rows: 24 },
      termControl,
      frame,
      page,
      url,
      previews: [{ url: "http://localhost:5173/", via: "marker" }],
      activity: [],
      sendInput(data) {
        // First keystroke = takeover; the UI banner + agent block follow.
        setTermControl((c) => (c === "agent" ? "user" : c))
        for (const ch of data) {
          if (ch === "\r" || ch === "\n") {
            const line = buf.current
            buf.current = ""
            setTermText((t) => `${t}\r\n${answer(line)}\r\n\u001b[90m$ \u001b[0m`)
          } else if (ch === "\x7f") {
            buf.current = buf.current.slice(0, -1)
            setTermText((t) => `${t}\x08 \x08`)
          } else if (ch >= " ") {
            buf.current += ch
            setTermText((t) => t + ch)
          }
        }
      },
      releaseTerminal() {
        setTermControl("agent")
        setTermText((t) => `${t}\u001b[2m ⟵ back to the agent\u001b[0m\r\n\u001b[90m$ \u001b[0m`)
      },
      resize: () => {},
      navigate(u) {
        const landedUrl = landed(u)
        setUrl(landedUrl)
        setFrame(drawFrame(landedUrl, clicks.current, page.width, page.height))
      },
      resizeBrowser(w, h) {
        setPage({ width: w, height: h })
        if (url) setFrame(drawFrame(url, clicks.current, w, h))
      },
      input(evt) {
        if (evt.kind === "mouse" && evt.event === "up") {
          clicks.current += 1
          setFrame(drawFrame(url ?? "", clicks.current, page.width, page.height))
        }
      },
    }
  }, [enabled, termText, termControl, frame, page, url])
}
