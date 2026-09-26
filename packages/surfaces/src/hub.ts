import {
  type ViewerClientMsg,
  ViewerClientMsg as ViewerClientMsgSchema,
  type ViewerServerMsg,
} from "@lilos/contracts/harness";
import type { ViewerScope, ViewerScopeEvent } from "./backend.js";

const b64encode = (b: Uint8Array): string => {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
};

function scopeEventToMsg(e: ViewerScopeEvent): ViewerServerMsg {
  switch (e.kind) {
    case "frame":
      return {
        type: "frame",
        jpeg: b64encode(e.jpeg),
        capturedAt: e.capturedAt,
      };
    case "term":
      return { type: "term", data: b64encode(e.data) };
    case "url":
      return { type: "url", url: e.url };
    case "previews":
      return { type: "previews", previews: e.previews };
    case "page":
      return { type: "page", page: e.page };
    case "term.control":
      return { type: "term.control", holder: e.holder };
    case "activity":
      return {
        type: "activity",
        tool: e.tool,
        status: e.status,
        summary: e.summary,
        at: e.at,
      };
  }
}

export interface ViewerPeer {
  /** Raw JSON text out to the socket. */
  send(text: string): void;
}

/**
 * Attaches one viewer socket to a scope (snapshot-then-live, spike #24
 * finding 3): on `attach` the viewer gets `hello` → latest frame → backlog
 * tail → previews; then live events fan out. `receive` routes takeover input
 * into the same browser/PTY the agent drives — one surface, two cursors.
 */
export function attachViewer(
  scope: ViewerScope,
  peer: ViewerPeer,
): {
  receive(text: string): void;
  detach(): void;
} {
  const send = (msg: ViewerServerMsg) => peer.send(JSON.stringify(msg));

  const snap = scope.snapshot();
  send({
    type: "hello",
    session: scope.session,
    page: snap.page,
    terminal: snap.terminal,
    control: snap.control,
    url: snap.url,
    previews: snap.previews,
  });
  if (snap.lastFrame)
    send({
      type: "frame",
      jpeg: b64encode(snap.lastFrame),
      capturedAt: Date.now(),
    });
  if (snap.termTail.length > 0)
    send({ type: "term", data: b64encode(snap.termTail) });

  const unsubscribe = scope.subscribe((e) => send(scopeEventToMsg(e)));

  return {
    receive(text) {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return; // malformed frame — drop, not fatal to the session
      }
      const msg = ViewerClientMsgSchema.safeParse(raw);
      if (!msg.success) return;
      const m: ViewerClientMsg = msg.data;
      switch (m.type) {
        case "term.input":
          scope.terminalInput(m.data);
          break;
        case "term.resize":
          scope.terminalResize(m.cols, m.rows);
          break;
        case "term.release":
          scope.terminalRelease();
          break;
        case "browser.input":
          scope.browserInput(m.event);
          break;
        case "browser.navigate":
          scope.browserNavigate(m.url);
          break;
        case "browser.resize":
          scope.browserResize(m.width, m.height);
          break;
      }
    },
    detach() {
      unsubscribe();
    },
  };
}
