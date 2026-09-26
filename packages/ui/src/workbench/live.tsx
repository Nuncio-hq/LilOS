import { GlobeIcon } from "lucide-react";
import { useRef } from "react";
import {
  Terminal,
  TerminalContent,
  TerminalHeader,
  TerminalTitle,
} from "../components/ai-elements/terminal";
import {
  WebPreview,
  WebPreviewNavigation,
  WebPreviewUrl,
} from "../components/ai-elements/web-preview";

/**
 * The live harness surfaces the Workbench renders when `live` is passed
 * (issue #36): the session's real PTY output and the owned browser's
 * screencast, with takeover input. All state arrives as props from the app's
 * viewer socket — this file owns only rendering + DOM event mapping.
 */
export interface LiveSurfaces {
  /** UTF-8 terminal output so far (ANSI allowed — Terminal renders it). */
  termText: string;
  terminal: { cols: number; rows: number };
  /** Latest screencast frame as an <img>-usable URL; null before the first. */
  frame: string | null;
  page: { width: number; height: number };
  url: string | null;
  previews: { url: string; via: "scan" | "marker" }[];
  activity: { tool: string; status: string; summary: string; at: number }[];
  /** keystroke / paste → PTY stdin */
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  navigate(url: string): void;
  input(evt: LiveBrowserInput): void;
}

export type LiveBrowserInput =
  | {
      kind: "mouse";
      event: "down" | "up" | "move";
      x: number;
      y: number;
      button: "left" | "middle" | "right";
    }
  | { kind: "wheel"; x: number; y: number; dx: number; dy: number }
  | {
      kind: "key";
      event: "down" | "up";
      key: string;
      text?: string;
      modifiers?: {
        ctrl: boolean;
        alt: boolean;
        shift: boolean;
        meta: boolean;
      };
    };

/** keystroke → PTY bytes, per terminal convention. */
function keyToInput(e: React.KeyboardEvent): string | null {
  if (e.metaKey || e.ctrlKey) {
    if (e.key.length === 1)
      return String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64);
    return null;
  }
  switch (e.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    default:
      return e.key.length === 1 ? e.key : null;
  }
}

export function LiveTerminal({
  live,
  cwd,
}: {
  live: LiveSurfaces;
  cwd: string;
}) {
  return (
    <Terminal
      output={live.termText || "[90mWaiting for terminal output…[0m"}
      isStreaming
      className="min-h-0 flex-1 rounded-none border-0"
    >
      <TerminalHeader className="py-1.5">
        <TerminalTitle className="text-xs">
          <span className="font-mono">{cwd}</span>
          <span className="rounded bg-emerald-800 px-1 text-[10px]">live</span>
        </TerminalTitle>
      </TerminalHeader>
      <div
        role="textbox"
        aria-label="Terminal input — click to type into the session's shell"
        tabIndex={0}
        className="flex min-h-0 flex-1 cursor-text flex-col outline-none focus:ring-1 focus:ring-emerald-600"
        onKeyDown={(e) => {
          const data = keyToInput(e);
          if (data) {
            e.preventDefault();
            live.sendInput(data);
          }
        }}
      >
        <TerminalContent className="max-h-none min-h-0 flex-1 text-xs" />
      </div>
    </Terminal>
  );
}

export function LivePreview({ live }: { live: LiveSurfaces }) {
  const imgRef = useRef<HTMLImageElement>(null);
  // object-contain letterboxes the frame inside the img box — map clicks
  // through the content rect, not the element rect.
  const toPage = (e: { clientX: number; clientY: number }) => {
    const img = imgRef.current;
    if (!img) return { x: 0, y: 0 };
    const r = img.getBoundingClientRect();
    const srcAspect = live.page.width / live.page.height;
    const boxAspect = r.width / r.height;
    const cw = boxAspect > srcAspect ? r.height * srcAspect : r.width;
    const ch = boxAspect > srcAspect ? r.height : r.width / srcAspect;
    const ox = r.left + (r.width - cw) / 2;
    const oy = r.top + (r.height - ch) / 2;
    return {
      x: Math.round(((e.clientX - ox) / cw) * live.page.width),
      y: Math.round(((e.clientY - oy) / ch) * live.page.height),
    };
  };
  return (
    <WebPreview
      defaultUrl={live.url ?? ""}
      onUrlChange={(u) => {
        if (u.trim()) live.navigate(u.trim());
      }}
      className="rounded-none border-0"
    >
      <WebPreviewNavigation className="p-1.5">
        <WebPreviewUrl />
        {live.url && (
          <span
            className="max-w-40 truncate font-mono text-[10px] text-muted-foreground"
            title={live.url}
          >
            {live.url}
          </span>
        )}
        <span className="rounded bg-emerald-800 px-1.5 py-0.5 text-[10px] text-emerald-100">
          live
        </span>
      </WebPreviewNavigation>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-neutral-950">
        {live.frame ? (
          <img
            ref={imgRef}
            src={live.frame}
            alt="live preview"
            className="absolute inset-0 h-full w-full object-contain"
            draggable={false}
            onMouseDown={(e) => {
              const p = toPage(e);
              live.input({
                kind: "mouse",
                event: "down",
                x: p.x,
                y: p.y,
                button: "left",
              });
            }}
            onMouseUp={(e) => {
              const p = toPage(e);
              live.input({
                kind: "mouse",
                event: "up",
                x: p.x,
                y: p.y,
                button: "left",
              });
            }}
            onWheel={(e) => {
              const p = toPage(e);
              live.input({
                kind: "wheel",
                x: p.x,
                y: p.y,
                dx: Math.round(e.deltaX),
                dy: Math.round(e.deltaY),
              });
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground text-xs">
            <GlobeIcon className="size-5" />
            {live.previews.length > 0 ? (
              <>
                <p>The session's dev server:</p>
                {live.previews.map((p) => (
                  <button
                    key={p.url}
                    type="button"
                    className="rounded border border-border px-2 py-1 font-mono hover:bg-accent"
                    onClick={() => live.navigate(p.url)}
                    title={`open ${p.url} (found via ${p.via})`}
                  >
                    {p.url}
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      {p.via}
                    </span>
                  </button>
                ))}
              </>
            ) : (
              <p>
                No page open yet. The browser opens when the agent calls{" "}
                <span className="font-mono">browser_open</span> — or a dev
                server prints a <span className="font-mono">localhost</span> URL
                / <span className="font-mono">PREVIEW:</span> marker in the
                terminal.
              </p>
            )}
          </div>
        )}
      </div>
    </WebPreview>
  );
}
