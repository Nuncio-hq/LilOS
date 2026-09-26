import { useMemo, useRef, useState } from "react"
import type { LiveSurfaces } from "@lilos/ui"

/* Prototype fake for the live Workbench surfaces (issue #36): a canned PTY
   session and a canvas-drawn "page" standing in for the harness screencast.
   sendInput echoes like a shell; navigate repaints the frame. */
const BANNER = [
  "\u001b[90m$ \u001b[0mbun dev",
  "\u001b[36mvite\u001b[0m v6 ready in 212 ms",
  "\u001b[32m➜\u001b[0m  Local:   http://localhost:5173/",
  "PREVIEW: http://localhost:5173/",
  "",
  "\u001b[90m$ \u001b[0m",
].join("\r\n")

function drawFrame(url: string, clicks: number): string {
  const c = document.createElement("canvas")
  c.width = 1280
  c.height = 800
  const g = c.getContext("2d")!
  const grad = g.createLinearGradient(0, 0, 1280, 800)
  grad.addColorStop(0, "#0c4a6e")
  grad.addColorStop(1, "#115e59")
  g.fillStyle = grad
  g.fillRect(0, 0, 1280, 800)
  g.fillStyle = "#f8fafc"
  g.font = "bold 64px system-ui"
  g.fillText("Acme Storefront", 80, 160)
  g.font = "28px system-ui"
  g.fillStyle = "#a5f3fc"
  g.fillText(url, 80, 220)
  g.fillStyle = "#f8fafc"
  g.fillRect(80, 300, 260, 72)
  g.fillStyle = "#0f172a"
  g.font = "bold 26px system-ui"
  g.fillText("Shop now", 140, 344)
  g.fillStyle = "#99f6e4"
  g.font = "22px system-ui"
  g.fillText(`agent clicks: ${clicks}`, 80, 430)
  return c.toDataURL("image/jpeg", 0.7)
}

export function useFakeSurfaces(enabled: boolean): LiveSurfaces | undefined {
  const [termText, setTermText] = useState(BANNER)
  const [frame, setFrame] = useState<string | null>(null)
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
        const u = cmd.slice(5).trim()
        setUrl(u)
        setFrame(drawFrame(u, clicks.current))
        return `opened ${u}`
      }
      return `${cmd}: command not found`
    }
    return {
      termText,
      terminal: { cols: 80, rows: 24 },
      frame,
      page: { width: 1280, height: 800 },
      url,
      previews: [{ url: "http://localhost:5173/", via: "marker" }],
      activity: [],
      sendInput(data) {
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
      resize: () => {},
      navigate(u) {
        setUrl(u)
        setFrame(drawFrame(u, clicks.current))
      },
      input(evt) {
        if (evt.kind === "mouse" && evt.event === "up") {
          clicks.current += 1
          setFrame(drawFrame(url ?? "", clicks.current))
        }
      },
    }
  }, [enabled, termText, frame, url])
}
