import { z } from "zod";
import { PreviewTarget } from "./tools.js";

/**
 * Workbench live-surface wire (issue #36, spike #24's viewer protocol): one
 * WebSocket per session scope at `GET <harness>/view?session=<id>`. On
 * connect the server sends `hello` then replays the snapshot (latest frame,
 * terminal backlog tail) — a reconnecting or just-opened Workbench renders
 * instantly, and closing the window costs nothing (screencast only runs
 * while a viewer watches).
 *
 * Frames are base64 JPEG from the owned browser's CDP screencast; terminal
 * chunks are base64 PTY bytes. Both directions stay JSON so the same schema
 * serves a browser Workbench and a native app.
 */

export const VIEWER_PATH = "/view";

/* ------------------------------ server → client ---------------------------- */

export const ViewerHello = z.object({
  type: z.literal("hello"),
  /** The session scope this socket is bound to. */
  session: z.string().min(1),
  /** Browser viewport; also the page-space the viewer's input coords map into. */
  page: z.object({ width: z.int().min(1), height: z.int().min(1) }),
  terminal: z.object({ cols: z.int().min(1), rows: z.int().min(1) }),
  /** Who holds the terminal right now ("user" = a Workbench human typing). */
  control: z.object({ terminal: z.enum(["agent", "user"]) }),
  /** Current page URL; null until the browser has navigated once. */
  url: z.string().nullable(),
  previews: z.array(PreviewTarget),
});
export type ViewerHello = z.infer<typeof ViewerHello>;

export const ViewerFrame = z.object({
  type: z.literal("frame"),
  /** Base64 JPEG. The latest frame is replayed to each new viewer. */
  jpeg: z.string(),
  /** Milliseconds since capture — the viewer can show frame age. */
  capturedAt: z.int().min(0),
});
export type ViewerFrame = z.infer<typeof ViewerFrame>;

export const ViewerTerm = z.object({
  type: z.literal("term"),
  /** Base64 PTY bytes. On attach, the backlog tail arrives as term msgs first. */
  data: z.string(),
});
export type ViewerTerm = z.infer<typeof ViewerTerm>;

export const ViewerUrl = z.object({
  type: z.literal("url"),
  url: z.string().nullable(),
});
export type ViewerUrl = z.infer<typeof ViewerUrl>;

export const ViewerPreviews = z.object({
  type: z.literal("previews"),
  previews: z.array(PreviewTarget),
});
export type ViewerPreviews = z.infer<typeof ViewerPreviews>;

/** The remote viewport changed (the pane's `browser.resize` landed). */
export const ViewerPage = z.object({
  type: z.literal("page"),
  page: z.object({ width: z.int().min(1), height: z.int().min(1) }),
});
export type ViewerPage = z.infer<typeof ViewerPage>;

/**
 * Terminal holder changed (issue #56): "user" means a Workbench keystroke
 * took the terminal — agent `terminal_run`/`terminal_write` calls get
 * `user_control` until `term.release`. Not a lock: the last viewer leaving
 * releases it automatically.
 */
export const ViewerTermControl = z.object({
  type: z.literal("term.control"),
  holder: z.enum(["agent", "user"]),
});
export type ViewerTermControl = z.infer<typeof ViewerTermControl>;

/** One tool call the agent made — the Workbench activity feed. */
export const ViewerActivity = z.object({
  type: z.literal("activity"),
  tool: z.string().min(1),
  status: z.enum(["started", "completed", "failed"]),
  summary: z.string(),
  at: z.int().min(0),
});
export type ViewerActivity = z.infer<typeof ViewerActivity>;

export const ViewerServerMsg = z.discriminatedUnion("type", [
  ViewerHello,
  ViewerFrame,
  ViewerTerm,
  ViewerUrl,
  ViewerPreviews,
  ViewerPage,
  ViewerTermControl,
  ViewerActivity,
]);
export type ViewerServerMsg = z.infer<typeof ViewerServerMsg>;

/* ------------------------------ client → server ---------------------------- */

export const ViewerTermInput = z.object({
  type: z.literal("term.input"),
  /** Raw bytes as UTF-8 text (keystrokes). */
  data: z.string(),
});
export type ViewerTermInput = z.infer<typeof ViewerTermInput>;

export const ViewerTermResize = z.object({
  type: z.literal("term.resize"),
  cols: z.int().min(1),
  rows: z.int().min(1),
});
export type ViewerTermResize = z.infer<typeof ViewerTermResize>;

/**
 * Human input for the owned page — the pixel path (CDP `Input.dispatch*`),
 * page-space coordinates. Selector actions stay on the tool surface; this is
 * the viewer's takeover channel only.
 */
export const ViewerBrowserInput = z.object({
  type: z.literal("browser.input"),
  event: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("mouse"),
      event: z.enum(["down", "up", "move"]),
      x: z.number(),
      y: z.number(),
      button: z.enum(["left", "middle", "right"]).default("left"),
    }),
    z.object({
      kind: z.literal("wheel"),
      x: z.number(),
      y: z.number(),
      dx: z.number(),
      dy: z.number(),
    }),
    z.object({
      kind: z.literal("key"),
      event: z.enum(["down", "up"]),
      key: z.string().min(1),
      /** Text to insert for printable keys. */
      text: z.string().optional(),
      modifiers: z
        .object({
          ctrl: z.boolean().default(false),
          alt: z.boolean().default(false),
          shift: z.boolean().default(false),
          meta: z.boolean().default(false),
        })
        .optional(),
    }),
  ]),
});
export type ViewerBrowserInput = z.infer<typeof ViewerBrowserInput>;
export type ViewerBrowserInputEvent = ViewerBrowserInput["event"];

export const ViewerBrowserNavigate = z.object({
  type: z.literal("browser.navigate"),
  url: z.string().min(1),
});
export type ViewerBrowserNavigate = z.infer<typeof ViewerBrowserNavigate>;

/** Resize the owned page to the viewer pane's pixel size (issue #56 AC-4). */
export const ViewerBrowserResize = z.object({
  type: z.literal("browser.resize"),
  width: z.int().min(1),
  height: z.int().min(1),
});
export type ViewerBrowserResize = z.infer<typeof ViewerBrowserResize>;

/** Hand the terminal back to the agent — the explicit takeover release. */
export const ViewerTermRelease = z.object({
  type: z.literal("term.release"),
});
export type ViewerTermRelease = z.infer<typeof ViewerTermRelease>;

export const ViewerClientMsg = z.discriminatedUnion("type", [
  ViewerTermInput,
  ViewerTermResize,
  ViewerBrowserInput,
  ViewerBrowserNavigate,
  ViewerBrowserResize,
  ViewerTermRelease,
]);
export type ViewerClientMsg = z.infer<typeof ViewerClientMsg>;
