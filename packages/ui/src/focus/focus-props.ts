import type { ReactNode } from "react";
import type { ThreadFrameProps } from "../thread/frame-props";
import type {
  HostAccessors,
  MergeMethod,
  OsApp,
  PullRequest,
  ShipBar,
  ShipHandlers,
  WbSpot,
  WbTab,
} from "../types";
import type { LiveSurfaces } from "../workbench/live";

/* The session view's props: everything the thread panel takes too
   (ThreadFrameProps) plus what only a view with a Workbench beside it needs. */
export interface FocusViewProps extends ThreadFrameProps {
  onBack?: () => void;
  /* `{error:true}` marks a failed action — the host toasts it with the
     destructive accent instead of a neutral note (#423). */
  say?: (t: string, opts?: { error?: boolean }) => void;
  repoFiles?: string[];
  /** Live host accessors forwarded to the Workbench (issue #11 fs/git, #37 forge). */
  host?: HostAccessors;
  onPrComment?: (t: string) => void | Promise<void>;
  onPrMerge?: (method: MergeMethod) => void | Promise<void>;
  /** Live harness surfaces for Workbench Terminal/Preview tabs (issue #36). */
  surfaces?: LiveSurfaces;
  /* os.open bound to the session (issue #110, the pair ThreadView takes with
     `editors`): the caller probes `host.describe` — onOpenPath={null} means
     os.open was absent, so the badge stays a plain label even when the
     accessors object statically carries the method (D-#19). Undefined keeps
     the prototype's own host.osEditors/osOpen path. */
  onOpenPath?: ((path: string, app: OsApp, line?: number) => void) | null;
  /* A pinned strip at the top of the conversation column (#423 AC-2 — the
     DM history-failure notice). The caller renders the surface (e.g. a
     StatusBanner); Focus only owns the slot above the scroll. */
  banner?: ReactNode;
  /* Extra surface content below the composer (the question card, #114). */
  children?: ReactNode;
  /* Workbench → Background: Stop a process (issue #170). */
  onStopJob?: (id: string) => void;
  /* This thread's own tabs of the LilOS Browser → Workbench Browser (#214). */
  browser?: ReactNode;
  /* Opens on this Workbench tab (e.g. a thread panel's "N subagents · Open" link, #317) —
     counts as the user's pick, so follow-the-agent doesn't switch away from it. */
  initialTab?: WbTab;
  /* The user picked a Workbench tab — the host syncs it into the URL so a
     reload lands on the same one (#319 AC-2). Follow-the-agent switches
     don't fire it: only picks go through pickTab. */
  onTab?: (t: WbTab) => void;
  /* The session's `workbench_open` request (issue #340): the panel opens and
     applies the target's tab — an explicit pick, so follow stops here. */
  wbSpot?: WbSpot;
  /* The Workbench ship bar's mock seam (issue #107/#359) — forwarded to
     Workbench.ship; live mode builds the same bar from `host` instead. */
  ship?: Partial<ShipBar> & ShipHandlers;
  /* Engine-declared capabilities forwarded to the Workbench (#587 AC-1):
     its Plan/Background/Subagents tabs gate on these flags so the strip's
     membership is fixed for the session — empty tabs grey, never pop in. */
  caps?: { plan?: boolean; subagents?: boolean; background?: boolean };
  /* #584: the ship bar's Suggest — the app's `session.ask` side request,
      returning the engine's answer text. Nothing is sent to the session. */
  onSuggest?: (files: string[]) => Promise<string | void> | string | void;
  /* #579 AC-1: the Workbench's live forge read reports the session's PR
     upward — a just-created/merged PR reaches the header chip instantly. */
  onPr?: (pr: PullRequest | null) => void;
  /* #660: the caller mounts the shared <main> landmark itself (the web
     SessionPane) so the pane element survives a view swap — omit → own <main>. */
  bare?: boolean;
}
