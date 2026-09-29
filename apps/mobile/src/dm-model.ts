import type {
  AppMessage,
  Ask,
  Conversation,
  ConversationSummary,
  RecentFolder,
} from "@lilos/contracts/app";
import type { ModelsListResult } from "@lilos/contracts/engine";
import type {
  Approval,
  FolderOption,
  ModelPick,
  ModelProviderRow,
  ModelRow,
  OrbTone,
  SessionState,
  SessionTurn,
  WorkspacePick,
} from "@lilos/ui-native";

/* Wire data -> ui-native DM view models (#156). Pure: no stores, no imports
   beyond contracts + ui-native types — every rule is unit-tested in
   test/dm-model.test.ts. Mirrors the web's DM list rules (apps/web) and the
   prototype's turnsOf/statusOf shapes. */

/** Last path segment — the picker's `project` label for a real folder. */
export function folderLeaf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() ?? trimmed;
}

/** "now" | "Nm" | "Nh" | weekday | "Mon d" — the list row's right-edge time. */
export function timeLabel(ts: number, now: number): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  const d = new Date(ts);
  if (s < 7 * 86_400)
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] ?? "";
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

/* --------------------------- state -> groups ---------------------------- */

/**
 * One thread's group: an open ask needs you first, then the wire state —
 * `active` means an engine turn is running; `pending` covers the window
 * between `conversations.open` answering and the host binding the session
 * (the row must not flash Done for a turn that just left the phone).
 */
export function conversationState(
  conv: Conversation,
  ctx: {
    openAsks: readonly Ask[];
    pending: ReadonlySet<string>;
  },
): SessionState {
  if (
    ctx.openAsks.some((a) => a.state === "open" && a.conversationId === conv.id)
  )
    return "needs-you";
  if (conv.state === "active" || ctx.pending.has(conv.id)) return "working";
  return "done";
}

/* ------------------------------- asks ---------------------------------- */

/** The one-line reason a needs-you row shows (approval or question ask). */
export function askReason(ask: Ask): string {
  const r = ask.request;
  if (r.kind === "approval") return r.description ?? r.command;
  // Plans (#180) have no mobile surface yet; the row still says why it waits.
  if (r.kind === "plan") return "Plan waiting for your review";
  return r.question;
}

export function askApproval(
  ask: Ask,
  ctx: {
    employeeId: string;
    employee: string;
    tone: OrbTone;
    session: string;
    now: number;
  },
): Approval {
  const r = ask.request;
  return {
    id: ask.id,
    employeeId: ctx.employeeId,
    employee: ctx.employee,
    tone: ctx.tone,
    session: ctx.session,
    reason: askReason(ask),
    ...(r.kind === "approval" ? { command: r.command } : {}),
    age: timeLabel(ask.createdAt, ctx.now),
  };
}

/* ------------------------------ the rows -------------------------------- */

export type DmCtx = {
  /** The DM channel id — summaries from other channels never enter. */
  channelId: string;
  employee: { id: string; name: string; tone: OrbTone };
  /** Open asks on this channel (the needs-you set). */
  openAsks: readonly Ask[];
  /** Opens this device sent whose summary row hasn't materialized yet. */
  pending: ReadonlyMap<
    string,
    { conversation: Conversation; root: AppMessage }
  >;
  now: number;
};

/** The employee's last words on the thread — the row's preview line. */
const lastWords = (s: ConversationSummary): string | undefined =>
  s.last.authorKind !== "user" ? s.last.text : s.firstAnswer?.text;

function toSessionTurn(s: ConversationSummary, ctx: DmCtx): SessionTurn {
  const conv = s.conversation;
  const state = conversationState(conv, {
    openAsks: ctx.openAsks,
    pending: new Set(ctx.pending.keys()),
  });
  const ask = ctx.openAsks.find(
    (a) => a.state === "open" && a.conversationId === conv.id,
  );
  const preview = lastWords(s);
  return {
    id: conv.id,
    prompt: s.root.text,
    title: conv.title || s.root.text,
    state,
    when: timeLabel(s.last.createdAt, ctx.now),
    ...(conv.cwd ? { folder: folderLeaf(conv.cwd) } : {}),
    ...(s.messageCount > 1 ? { replies: s.messageCount - 1 } : {}),
    ...(preview ? { preview } : {}),
    ...(state === "working" && !preview ? { live: "Working…" } : {}),
    ...(ask
      ? {
          approval: askApproval(ask, {
            employeeId: ctx.employee.id,
            employee: ctx.employee.name,
            tone: ctx.employee.tone,
            session: conv.title || s.root.text,
            now: ctx.now,
          }),
        }
      : {}),
    ...(conv.model ? { model: conv.model } : {}),
  };
}

/**
 * summaries (+ locally-pending opens) -> SessionTurn rows, OLDEST activity
 * first — EmployeeDmScreen reverses the list, so each group then renders
 * newest first (the screen's GROUPS constant does the bucketing).
 */
export function toSessionTurns(
  summaries: readonly ConversationSummary[],
  ctx: DmCtx,
): SessionTurn[] {
  const rows = summaries
    .filter((s) => s.conversation.channelId === ctx.channelId)
    .map((s) => ({ turn: toSessionTurn(s, ctx), at: s.last.createdAt }));
  // A just-sent open may still lack a summary (refresh in flight): render it
  // from what the phone itself wrote so the Working row appears at once.
  for (const [id, p] of ctx.pending) {
    if (p.conversation.channelId !== ctx.channelId) continue;
    if (summaries.some((s) => s.conversation.id === id)) continue;
    rows.push({
      at: p.conversation.createdAt,
      turn: {
        id,
        prompt: p.root.text,
        title: p.conversation.title || p.root.text,
        state: "working",
        when: timeLabel(p.conversation.createdAt, ctx.now),
        live: "Working…",
        ...(p.conversation.cwd
          ? { folder: folderLeaf(p.conversation.cwd) }
          : {}),
      },
    });
  }
  rows.sort((a, b) => a.at - b.at);
  return rows.map((r) => r.turn);
}

/* ----------------------------- the header ------------------------------- */

/** "N need you" wins, then "Working on N", else "Idle" (prototype statusOf). */
export function headerStatus(turns: { state: string }[]): string {
  const needs = turns.filter((t) => t.state === "needs-you").length;
  const working = turns.filter((t) => t.state === "working").length;
  if (needs) return needs === 1 ? "1 needs you" : `${needs} need you`;
  if (working) return working === 1 ? "Working" : `Working on ${working}`;
  return "Idle";
}

/* ------------------------------- pickers -------------------------------- */

/**
 * `folders.list` recents -> picker rows. The wire carries only {path,
 * lastUsedAt}; the host git probe that supplies branches/workstreams is
 * loopback-only (not reachable from a phone), so branch/workstream rows stay
 * empty — the sheet then offers its direct/just-chat modes (the same cwd a
 * direct pick produces on web).
 */
export function toFolderOptions(
  folders: readonly RecentFolder[],
): FolderOption[] {
  return folders.map((f) => ({
    id: f.path,
    project: folderLeaf(f.path),
    path: f.path,
    branches: [],
    workstreams: [],
  }));
}

export function toModelCatalog(
  result: Pick<ModelsListResult, "models" | "providers">,
): { models: ModelRow[]; providers: ModelProviderRow[] } {
  return {
    models: (result.models ?? []).map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      provider: m.provider ?? "",
      ...(m.efforts ? { efforts: m.efforts } : {}),
      ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
      ...(m.fast !== undefined ? { fast: m.fast } : {}),
    })),
    providers: (result.providers ?? []).map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      // The wire has no logo field; known ids get their models.dev slug.
      logo: PROVIDER_LOGO[p.id],
    })),
  };
}

/** Provider slug -> models.dev logo slug (the prototype's PROVIDERS map). */
const PROVIDER_LOGO: Record<string, string | undefined> = {
  hpc: "alibaba",
  "anthropic-cliproxy": "anthropic",
  "openai-codex": "openai",
  "xai-oauth": "xai",
};

/** The pick the composer starts with: employee model > engine default. */
export function defaultModelPick(opts: {
  employeeModel?: string;
  models: readonly ModelRow[];
  defaultModel?: string;
  defaultProvider?: string;
}): ModelPick | undefined {
  const want = opts.employeeModel || opts.defaultModel;
  if (!want) return opts.models[0] ? { model: opts.models[0].id } : undefined;
  /* The employee's own model needs no provider disambiguation (its pick is
     authoritative); the engine default does — the same model id can exist
     under two providers, and the default's provider is the intended one. */
  const row = opts.models.find(
    (m) =>
      m.id === want &&
      (opts.employeeModel ||
        !opts.defaultProvider ||
        m.provider === opts.defaultProvider ||
        opts.models.filter((x) => x.id === want).length === 1),
  );
  return row
    ? {
        model: row.id,
        ...(row.defaultEffort ? { effort: row.defaultEffort } : {}),
      }
    : { model: want };
}

/**
 * The folder the composer starts on: the employee's most recent session
 * folder when it's still a recents entry, else "just chat" (web #113 AC-6 —
 * never stomp a pick the user already made, so callers apply this only to
 * fill an absent pick).
 */
export function defaultWorkspacePick(
  folders: readonly FolderOption[],
  lastCwd?: string,
): WorkspacePick {
  const hit = lastCwd && folders.find((f) => f.path === lastCwd);
  return hit
    ? { folder: hit.id, base: hit.branches[0] ?? "", mode: "direct" }
    : { folder: null, base: "", mode: "direct" };
}

/**
 * Workspace + model picks -> `conversations.open` params (same fields the
 * web's sendDm stamps — the pick rides the open call so session.start sees
 * it). Unknown/absent folders send no cwd (just chat).
 */
export function openConversationParams(opts: {
  workspace: WorkspacePick;
  folders: readonly FolderOption[];
  model?: ModelPick;
  models?: readonly ModelRow[];
}): {
  cwd?: string;
  model?: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
} {
  const folder = opts.workspace.folder
    ? opts.folders.find((f) => f.id === opts.workspace.folder)
    : undefined;
  const row = opts.model
    ? opts.models?.find((m) => m.id === opts.model?.model)
    : undefined;
  return {
    ...(folder ? { cwd: folder.path } : {}),
    ...(opts.model?.model ? { model: opts.model.model } : {}),
    ...(row?.provider ? { provider: row.provider } : {}),
    ...(opts.model?.effort !== undefined ? { effort: opts.model.effort } : {}),
    ...(opts.model?.fast !== undefined ? { fast: opts.model.fast } : {}),
  };
}
