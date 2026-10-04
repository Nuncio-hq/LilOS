import type {
  AppMessage,
  Ask,
  Conversation,
  ConversationSummary,
  FoldersDetailResult,
  RecentFolder,
  WorkspaceIntent,
} from "@lilos/contracts/app";
import type { ModelsListResult } from "@lilos/contracts/engine";
import type {
  Approval,
  FolderOption,
  MacDir,
  ModelPick,
  ModelProviderRow,
  ModelRow,
  OrbTone,
  PullRequestRef,
  SessionState,
  SessionTurn,
  WorkspacePick,
} from "@lilos/ui-native";
import { hasProviderLogo } from "@lilos/ui-native/provider-logos";

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

/** The one-line reason a needs-you row shows (approval or question ask).
    #264: an approval's reason is its command — the wire `description` is
    only the engine's own "wants to run: <cmd>" echo, so surfaces compose
    their own sentence (the card's "<employee> wants to run", the decided
    receipt's "You approved:") and the command shows once, untruncated. */
export function askReason(ask: Ask): string {
  const r = ask.request;
  if (r.kind === "approval") return r.command;
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
    kind: r.kind,
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
  /** Each conversation's PRs (#159) — absent key = nothing to show (AC-4). */
  prs?: Readonly<Record<string, PullRequestRef[]>>;
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
    ...(convFolderLabel(conv) ? { folder: convFolderLabel(conv) } : {}),
    ...(conv.workspace?.branch ? { branch: conv.workspace.branch } : {}),
    ...(ctx.prs?.[conv.id]?.length ? { prs: ctx.prs[conv.id] } : {}),
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
    /* #424: the runtime fetches includeArchived so it KNOWS the flag — the
       phone's job is hiding it (the Mac keeps an Archived disclosure; the
       compact list drops the row). conversation.updated carries the flip in
       one update, so archive hides and unarchive returns here. */
    .filter(
      (s) =>
        s.conversation.channelId === ctx.channelId && !s.conversation.archived,
    )
    .map((s) => ({ turn: toSessionTurn(s, ctx), at: s.last.createdAt }));
  // A just-sent open may still lack a summary (refresh in flight): render it
  // from what the phone itself wrote so the Working row appears at once.
  for (const [id, p] of ctx.pending) {
    /* #424: same cut as the summary path — a stale pending marker must not
       resurrect a session the Mac already archived. */
    if (p.conversation.channelId !== ctx.channelId || p.conversation.archived)
      continue;
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
        ...(convFolderLabel(p.conversation)
          ? { folder: convFolderLabel(p.conversation) }
          : {}),
        ...(p.conversation.workspace?.branch
          ? { branch: p.conversation.workspace.branch }
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

/** A workstream-opened row labels its repo (cwd is the `.lilos/wt` dir). */
function convFolderLabel(conv: Conversation): string | undefined {
  const path = conv.workspace?.repoPath ?? conv.cwd;
  return path ? folderLeaf(path) : undefined;
}

/**
 * `folders.list` recents + per-folder `folders.detail` probes -> picker
 * rows (#156). A folder whose detail hasn't landed yet is `probing` — the
 * sheet shows "Checking git…" instead of misreading it as a non-repo.
 */
export function toFolderOptions(
  folders: readonly RecentFolder[],
  details?: Readonly<Record<string, FoldersDetailResult>>,
): FolderOption[] {
  return folders.map((f) => {
    const d = details?.[f.path];
    return {
      id: f.path,
      project: folderLeaf(f.path),
      path: f.path,
      ...(d === undefined ? { probing: true } : {}),
      ...(d?.missing ? { missing: true } : {}),
      branches: d?.branches ?? [],
      workstreams: (d?.workstreams ?? []).map((w) => ({
        branch: w.branch,
        path: w.path,
        ...(w.from ? { from: w.from } : {}),
      })),
    };
  });
}

/** The "ws/<slug>"-style branch + `.lilos/wt/<slug>` dir name from a prompt. */
function slugOf(text: string): string {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (w) =>
        w &&
        !["a", "an", "the", "with", "on", "for", "of", "to", "and"].includes(w),
    )
    .slice(0, 2)
    .join("-");
}

/** Deduped worktree slug: free as both dir name and `ws/<slug>` branch. */
function uniqueWorkSlug(folder: FolderOption, base: string): string {
  const taken = new Set([
    ...folder.branches,
    ...folder.workstreams.map((w) => w.branch),
    ...folder.workstreams.map((w) => folderLeaf(w.path)),
  ]);
  let slug = base;
  for (let n = 1; taken.has(slug) || taken.has(`ws/${slug}`); n++)
    slug = `${base}-${n}`;
  return slug;
}

/**
 * The composer's pick once a browsed Mac folder gets used (#238): a folder
 * inside a git repo starts a new workstream off its checked-out branch;
 * anything else runs in it directly (prototype BrowseMac's onUse rule).
 */
export function browseWorkspacePick(path: string, dir: MacDir): WorkspacePick {
  return {
    folder: path,
    base: dir.branch ?? "",
    mode: dir.branch ? "new" : "direct",
  };
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
      /* The engine-reported window rides the catalog row — the meter's
         `contextWindowOf` reads it here like the web's (#294). */
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    })),
    providers: (result.providers ?? []).map((p) => ({
      id: p.id,
      name: p.name ?? providerTitle(p.id),
      // The wire has no logo field: known provider aliases map onto their
      // models.dev slug, and an id that already IS a known slug gets it
      // directly — anything else renders the generic chip (#160 AC-3).
      logo: PROVIDER_LOGO[p.id] ?? (hasProviderLogo(p.id) ? p.id : undefined),
    })),
  };
}

/** Provider slug -> models.dev logo slug for engine ids that differ from
    their models.dev mark (the prototype's PROVIDERS map). */
const PROVIDER_LOGO: Record<string, string | undefined> = {
  hpc: "alibaba",
  "anthropic-cliproxy": "anthropic",
  "openai-codex": "openai",
  "xai-oauth": "xai",
};

/* Provider slug -> display name when the engine didn't name it (web
   PROVIDER_NAMES + a title-cased fallback). */
const PROVIDER_NAMES: Record<string, string> = {
  alibaba: "Alibaba",
  amazon: "Amazon",
  anthropic: "Anthropic",
  azure: "Azure",
  cerebras: "Cerebras",
  cognition: "Cognition",
  cohere: "Cohere",
  deepseek: "DeepSeek",
  fireworks: "Fireworks AI",
  "github-copilot": "GitHub Copilot",
  google: "Google",
  groq: "Groq",
  meta: "Meta",
  mistral: "Mistral AI",
  moonshotai: "Moonshot AI",
  nvidia: "NVIDIA",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  togetherai: "Together AI",
  vercel: "Vercel",
  xai: "xAI",
  zai: "Z.ai",
};

function providerTitle(slug: string): string {
  return (
    PROVIDER_NAMES[slug] ??
    slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/** The pick the composer starts with: employee model > engine default. */
export function defaultModelPick(opts: {
  employeeModel?: string;
  models: readonly ModelRow[];
  defaultModel?: string;
  defaultProvider?: string;
}): ModelPick | undefined {
  const want = opts.employeeModel || opts.defaultModel;
  if (!want)
    return opts.models[0]
      ? {
          model: opts.models[0].id,
          ...(opts.models[0].provider
            ? { provider: opts.models[0].provider }
            : {}),
        }
      : undefined;
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
        ...(row.provider ? { provider: row.provider } : {}),
        /* The declared default seeds the pick only when the ladder has it
           (web defaultEffort) — otherwise the engine's own default runs. */
        ...(row.defaultEffort && row.efforts?.includes(row.defaultEffort)
          ? { effort: row.defaultEffort }
          : {}),
      }
    : { model: want };
}

/**
 * The folder the composer starts on: the employee's most recent session
 * folder when it's still a recents entry, else "just chat" (web #113 AC-6 —
 * never stomp a pick the user already made, so callers apply this only to
 * fill an absent pick). Defaults to a new workstream like the sheet does —
 * resolved non-repos degrade to direct on send.
 */
export function defaultWorkspacePick(
  folders: readonly FolderOption[],
  lastCwd?: string,
): WorkspacePick {
  const hit = lastCwd && folders.find((f) => f.path === lastCwd);
  if (!hit) return { folder: null, base: "", mode: "direct" };
  return {
    folder: hit.id,
    base: hit.branches[0] ?? "",
    mode: hit.probing || hit.branches.length ? "new" : "direct",
  };
}

/**
 * Workspace + model picks -> `conversations.open` params (same fields the
 * web's sendDm stamps — the pick rides the open call so session.start sees
 * it). Unknown/absent folders send no cwd (just chat).
 *
 * "new" mode computes the `ws/<slug>` branch + `.lilos/wt/<slug>` dir from
 * the first message (prototype resolveWs); the harness materializes the
 * worktree before the session binds.
 */
export function openConversationParams(opts: {
  workspace: WorkspacePick;
  folders: readonly FolderOption[];
  model?: ModelPick;
  models?: readonly ModelRow[];
  /** The first message — a "new workstream" pick names its branch/dir from it. */
  text?: string;
}): {
  cwd?: string;
  workspace?: WorkspaceIntent;
  model?: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
} {
  const pick = opts.workspace;
  const folder = pick.folder
    ? opts.folders.find((f) => f.id === pick.folder)
    : undefined;
  const ws = workspaceOpen(pick, folder, opts.text);
  /* The pick's own provider wins (a shared id under two providers pins the
     picked one); a bare id resolves the first matching row (#160 AC-4). */
  const row = opts.model
    ? opts.models?.find(
        (m) =>
          m.id === opts.model?.model &&
          (opts.model?.provider === undefined ||
            m.provider === opts.model.provider),
      )
    : undefined;
  const provider = opts.model?.provider ?? row?.provider;
  return {
    ...ws,
    ...(opts.model?.model ? { model: opts.model.model } : {}),
    ...(provider ? { provider } : {}),
    ...(opts.model?.effort !== undefined ? { effort: opts.model.effort } : {}),
    ...(opts.model?.fast !== undefined ? { fast: opts.model.fast } : {}),
  };
}

function workspaceOpen(
  pick: WorkspacePick,
  folder: FolderOption | undefined,
  text: string | undefined,
): { cwd?: string; workspace?: WorkspaceIntent } {
  if (!folder || folder.missing) return {};
  if (pick.mode === "new" && folder.branches.length) {
    const slug = uniqueWorkSlug(folder, slugOf(text ?? "") || "session");
    return {
      cwd: `${folder.path}/.lilos/wt/${slug}`,
      workspace: {
        mode: "new",
        repoPath: folder.path,
        branch: `ws/${slug}`,
        base: pick.base || folder.branches[0] || "",
      },
    };
  }
  if (pick.mode === "existing") {
    const w = folder.workstreams.find((x) => x.branch === pick.existing);
    if (w) {
      return {
        cwd: w.path,
        workspace: {
          mode: "existing",
          repoPath: folder.path,
          branch: w.branch,
        },
      };
    }
    /* The workstream is gone since the probe — fall through to direct. */
  }
  return { cwd: folder.path };
}
