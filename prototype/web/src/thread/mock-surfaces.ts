import type { FocusView, V3Workbench } from "@lilos/ui"
import { type ComponentProps, useMemo, useRef, useState } from "react"

/* The live-surface seam (a terminal and a page): the app backs it with the
   harness's PTY and browser. Here the terminal replays the commands the
   mock workbench recorded and then answers like a small shell, and the
   preview is a drawn page for the dev server the agent started. The first
   keystroke takes the terminal from the agent, like the real surface does. */

export type LiveSurfaces = NonNullable<ComponentProps<typeof FocusView>["surfaces"]>

const PROMPT = "\u001b[90m$ \u001b[0m"

function replay(wb: V3Workbench): string {
  const ran = wb.terminal
    .map((c) => `${PROMPT}${c.cmd}\r\n${c.lines.join("\r\n")}\r\n`)
    .join("")
  return ran + (wb.terminal.at(-1)?.running ? "" : PROMPT)
}

function drawFrame(title: string, url: string, w: number, h: number): string {
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  const g = c.getContext("2d")
  if (!g) return ""
  g.fillStyle = "#f8fafc"
  g.fillRect(0, 0, w, h)
  const s = Math.max(0.4, Math.min(w / 1280, h / 800))
  g.fillStyle = "#0f172a"
  g.font = `bold ${Math.round(48 * s)}px system-ui`
  g.fillText(title, 64 * s, 120 * s)
  g.fillStyle = "#64748b"
  g.font = `${Math.round(24 * s)}px system-ui`
  g.fillText(url, 64 * s, 170 * s)
  return c.toDataURL("image/jpeg", 0.7)
}

/** Where a real browser ends up: scheme filled in. */
const landed = (raw: string) => (/^https?:\/\//.test(raw) ? raw : `https://${raw}`)

export function useMockSurfaces(wb: V3Workbench | undefined): LiveSurfaces | undefined {
  const [text, setText] = useState(() => (wb ? replay(wb) : ""))
  const [control, setControl] = useState<"agent" | "user">("agent")
  const [page, setPage] = useState({ width: 1280, height: 800 })
  const [url, setUrl] = useState<string | null>(wb?.preview?.url ?? null)
  const line = useRef("")
  const title = useRef(wb?.preview?.title ?? "")
  const frame = useMemo(
    () => (url ? drawFrame(title.current || url, url, page.width, page.height) : null),
    [url, page],
  )
  return useMemo(() => {
    if (!wb) return undefined
    const answer = (cmd: string): string => {
      if (cmd.startsWith("echo ")) return cmd.slice(5)
      if (cmd === "ls") return wb.files.filter((f) => !f.slice(0, -1).includes("/")).join("  ")
      return cmd ? `${cmd}: command not found` : ""
    }
    return {
      termText: text,
      terminal: { cols: 80, rows: 24 },
      termControl: control,
      frame,
      page,
      url,
      previews: wb.preview ? [{ url: wb.preview.url, via: "marker" as const }] : [],
      activity: [],
      sendInput(data) {
        setControl("user")
        for (const ch of data) {
          if (ch === "\r" || ch === "\n") {
            const cmd = line.current.trim()
            line.current = ""
            setText((t) => `${t}\r\n${answer(cmd)}\r\n${PROMPT}`)
          } else if (ch === "\x7f") {
            line.current = line.current.slice(0, -1)
            setText((t) => `${t}\b \b`)
          } else if (ch >= " ") {
            line.current += ch
            setText((t) => t + ch)
          }
        }
      },
      releaseTerminal() {
        setControl("agent")
        setText((t) => `${t}\u001b[2m back to the agent\u001b[0m\r\n${PROMPT}`)
      },
      resize: () => {},
      navigate: (u) => setUrl(landed(u)),
      resizeBrowser: (width, height) => setPage({ width, height }),
      input: () => {},
    }
  }, [wb, text, control, frame, page, url])
}
