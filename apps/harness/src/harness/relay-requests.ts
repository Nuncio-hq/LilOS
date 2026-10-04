import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Conversation,
  ConversationsRewindHostParams,
  type ConversationsRewindHostResult,
  ENGINE_PASSTHROUGH_METHODS,
  FoldersBrowseParams,
  type FoldersBrowseResult,
  FoldersDetailParams,
  type FoldersDetailResult,
  type FoldersDiscoverResult,
} from "@lilos/contracts/app";
import { EventsSinceParams } from "@lilos/contracts/engine";
import {
  callHost,
  collapsePath,
  expandPath,
  fsList,
  gitBranches,
  gitDiscoverRepos,
  gitIsRepo,
  gitWorktrees,
  HOST_ERRORS,
  HostError,
  resolveUnderHome,
  worktreeAdd,
} from "@lilos/host";
import { engineErrorCode } from "../engine/client";
import type { HarnessCtx } from "./ctx";
import {
  ENGINE_CALL_DEADLINE_MS,
  ENGINE_UNAVAILABLE,
  INVALID_STATE,
} from "./rpc";

/**
 * Relay-forwarded calls the harness answers (D-#26):
 * engine passthrough, `conversations.rewind`, folder probes, `forge.prs`
 * (was the request half of the `relay -> engine` section of
 * `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

/**
 * `conversations.rewind` arrives as a relay-forwarded host call (#134):
 * restore the folder to the checkpoint stamped on the target message, drop
 * queued user messages the rewind removes, and — when the session's engine
 * declares `rewind` — drop the turns from its context too. Throws (code
 * -32009 conflict) while a turn runs; throwing before the mark means the
 * relay leaves the thread untouched.
 */
export async function rewindConversation(
  this: HarnessCtx,
  params: ConversationsRewindHostParams,
): Promise<ConversationsRewindHostResult> {
  const binding = this.bindings.get(params.conversationId);
  /* #274 same overtaking class as interrupt: a rewind landing inside a
     send's pre-dispatch window would restore the folder and then the
     pending prompt still runs. Wait for in-flight sends to dispatch —
     then either a turn exists and the conflict below refuses, or the
     send bailed and the rewind proceeds. */
  if (binding?.promptGates.size) await Promise.all(binding.promptGates);
  // A rebind may have swapped the binding while the gates were held.
  const live = binding ? this.liveBinding(binding) : undefined;
  if (this.bindings.get(params.conversationId)?.runningTurnId) {
    throw Object.assign(
      new Error("a turn is still running — stop it before rewinding"),
      { code: -32009 },
    );
  }
  /* Restore only into a real folder (#412): a folder-less session's
     fallback cwd is the user's home — restoring a checkpoint there would
     delete user files. `params.cwd` (a scheduled/scripted rewind naming
     its target) still wins. Stored cwd may be `~/x` (host fs echoes
     collapsed): expand before any fs use. */
  const restoreCwd = params.cwd ?? (live?.hasFolder ? live.cwd : undefined);
  /* Engine first: a refusal (INVALID_STATE — a turn is running) must leave
     everything untouched, before any file or queue mutation. */
  let engineRewound = false;
  const conn = this.engine;
  const sessionId = live?.sessionId ?? params.engineRef ?? undefined;
  if (conn && sessionId && this.hasCapability("rewind")) {
    try {
      await conn.request("session.rewind", {
        sessionId,
        toTurn: params.toTurn,
      });
      engineRewound = true;
    } catch (error) {
      const code = engineErrorCode(error);
      if (code === INVALID_STATE) {
        throw Object.assign(
          new Error("the engine refused the rewind — a turn may be running"),
          { code: -32009 },
        );
      }
      // Method missing / transport can't rewind (ACP): the AC-3 path —
      // files still restore, the note tells the user, and the app offers
      // "Start a new session from here".
      this.opts.log.warn("engine session.rewind failed", {
        sessionId,
        error: String(error),
      });
    }
  }
  let filesRestored = false;
  if (params.checkpoint && this.opts.checkpoints && restoreCwd) {
    await this.opts.checkpoints.restore(
      expandPath(restoreCwd, this.home),
      params.checkpoint,
    );
    filesRestored = true;
  }
  /* Queued-behind-a-turn user messages at/after the rewind point never
     send; release their delivery claims so nothing re-prompts them. The
     `early` map holds the same kind of queued sends for sessions with no
     binding yet — prune it identically. */
  if (live) {
    live.queue = live.queue.filter((m) => {
      if (m.seq >= params.fromSeq) live.consumed.delete(m.id);
      return m.seq < params.fromSeq;
    });
  }
  const early = this.early.get(params.conversationId);
  if (early?.length) {
    const kept = early.filter((m) => m.seq < params.fromSeq);
    if (kept.length) this.early.set(params.conversationId, kept);
    else this.early.delete(params.conversationId);
  }
  return { engineRewound, filesRestored };
}

/**
 * The relay asks the harness to answer engine calls on its behalf
 * (harness = the only engine talker, D-#26). Only the declared passthrough
 * set is honored; anything else is a JSON-RPC method-not-found.
 */
export function onRelayRequest(
  this: HarnessCtx,
  method: string,
  params: Record<string, unknown>,
) {
  /* `conversations.rewind` is relay-initiated (not passthrough): the
     harness restores the folder checkpoint and rewinds the engine session
     when its transport can. */
  if (method === "conversations.rewind") {
    return this.rewindConversation(ConversationsRewindHostParams.parse(params));
  }
  /* `folders.detail` (#156): the relay gates the path to recents and
     forwards here — the only process that can run git on this machine. */
  if (method === "folders.detail") {
    return this.folderDetail(FoldersDetailParams.parse(params));
  }
  /* `folders.browse`/`folders.discover` (#238): the phone's folder
     browser — the home-folder boundary is enforced here, server-side,
     because the caller is a remote device. */
  if (method === "folders.browse") {
    return this.folderBrowse(FoldersBrowseParams.parse(params));
  }
  if (method === "folders.discover") {
    return this.folderDiscover();
  }
  /* `forge.prs` (#159): a thread's PRs — the relay resolves the
     conversation's folder + branch(es) and forwards here, the only
     `gh`-capable process. The host API validates params + result. */
  if (method === "forge.prs") {
    return callHost("forge.prs", params);
  }
  /* `events.since` (#157): the relay's `session.events` maps a
     conversationId onto its bound engine session and forwards here —
     verbatim engine replay, so a device-scope client never sees a
     session id it didn't resolve through the conversation. */
  if (method === "events.since") {
    const parsed = EventsSinceParams.parse(params);
    return this.eventsSince(parsed.sessionId, parsed.after);
  }
  if (!(ENGINE_PASSTHROUGH_METHODS as readonly string[]).includes(method)) {
    throw Object.assign(new Error(`harness does not answer ${method}`), {
      code: -32601,
    });
  }
  const conn = this.engine;
  if (!conn) {
    throw Object.assign(new Error("engine not connected"), {
      code: ENGINE_UNAVAILABLE,
    });
  }
  /* #482: a timeout (no numeric code — transport deadline, not an engine
     error frame) is re-minted `engine_unavailable` so the app surfaces a
     typed miss instead of a generic engine_error. */
  return conn
    .request(method, params, ENGINE_CALL_DEADLINE_MS)
    .catch((error) => {
      if (engineErrorCode(error) === undefined)
        throw Object.assign(
          new Error(
            `engine ${method} timed out after ${ENGINE_CALL_DEADLINE_MS}ms`,
          ),
          { code: ENGINE_UNAVAILABLE },
        );
      throw error;
    });
}

/**
 * `folders.detail` probe (#156): branches + linked worktrees of one
 * recents-listed folder — the picker's "New workstream from" and
 * "Continue a workstream" rows. The repo's own checkout is filtered out
 * of `workstreams` (it is the "direct" mode, not a workstream).
 */
export async function folderDetail(
  this: HarnessCtx,
  params: FoldersDetailParams,
): Promise<FoldersDetailResult> {
  const abs = expandPath(params.path, this.home);
  const empty = {
    path: params.path,
    isRepo: false,
    branches: [] as string[],
    workstreams: [],
  };
  if (!existsSync(abs)) return { ...empty, missing: true };
  const probe = await gitIsRepo({ path: abs });
  if (!probe.isRepo || !probe.root) return { ...empty, missing: false };
  const [branches, worktrees] = await Promise.all([
    gitBranches({ path: abs }),
    gitWorktrees({ path: abs }),
  ]);
  const root = resolve(expandPath(probe.root, this.home));
  return {
    ...empty,
    missing: false,
    isRepo: true,
    root: probe.root,
    current: branches.current,
    branches: branches.branches,
    remote: branches.remote,
    workstreams: worktrees.worktrees
      .filter(
        (w) =>
          w.branch !== undefined &&
          resolve(expandPath(w.path, this.home)) !== root,
      )
      .map((w) => ({
        branch: w.branch ?? "",
        path: w.path,
        ...(w.from ? { from: w.from } : {}),
      })),
  };
}

/**
 * `folders.browse` (#238): one folder level under the Mac's home — dirs
 * only, dot-dirs skipped, repo children carrying their branch (the same
 * marks the web AddFolderDialog paints on `fs.list`). The listed dir's
 * own `branch` is its containing repo's current branch (the web's
 * `hostIsRepo`+`hostBranches` probe). Anything that resolves outside
 * home — `..`, absolute paths, symlink hops, dot-dir segments — is
 * refused before any listing happens.
 */
export async function folderBrowse(
  this: HarnessCtx,
  params: FoldersBrowseParams,
): Promise<FoldersBrowseResult> {
  const home = this.home;
  const abs = resolveUnderHome(params.path, home);
  if (!abs) {
    throw new HostError(
      HOST_ERRORS.OUTSIDE_ROOT,
      `path is outside the Mac's home folder: ${params.path}`,
    );
  }
  const [list, self] = await Promise.all([
    fsList({ path: abs }),
    gitBranches({ path: abs }).catch(() => null),
  ]);
  return {
    path: collapsePath(abs, home),
    ...(self?.current ? { branch: self.current } : {}),
    folders: list.entries
      .filter((e) => e.kind === "dir" && !e.name.startsWith("."))
      .map((e) => ({
        name: e.name,
        path: collapsePath(join(abs, e.name), home),
        ...(e.repo?.head ? { branch: e.repo.head } : {}),
      })),
  };
}

/**
 * `folders.discover` (#238): repos under the web's "Found on this Mac"
 * roots, each re-checked against the home boundary so a symlinked scan
 * root can't leak outside paths.
 */
export async function folderDiscover(
  this: HarnessCtx,
): Promise<FoldersDiscoverResult> {
  const home = this.home;
  /* Same roots as the web picker (apps/web/src/lib/host.ts hostRoots). */
  const roots = ["~/Desktop", "~/Developer", "~/Documents", "~/repos"].map(
    (r) => expandPath(r, home),
  );
  const { repos } = await gitDiscoverRepos({ roots });
  return {
    repos: repos.flatMap((r) => {
      const abs = resolveUnderHome(r.path, home);
      return abs
        ? [
            {
              path: collapsePath(abs, home),
              ...(r.head ? { branch: r.head } : {}),
            },
          ]
        : [];
    }),
  };
}

/**
 * A `workspace.mode === "new"` open (#156) carries `cwd` as the worktree
 * path the picker computed (`<repo>/.lilos/wt/<slug>`): make it real with
 * `git worktree add -b <branch> <base>` before the first `session.start`,
 * unless a registered worktree already sits there (rebind after a
 * restart, a redelivered turn).
 */
export async function ensureWorktree(
  this: HarnessCtx,
  conv: Conversation,
): Promise<void> {
  const ws = conv.workspace;
  if (ws?.mode !== "new" || !conv.cwd) return;
  const dir = resolve(expandPath(conv.cwd, this.home));
  const { worktrees } = await gitWorktrees({ path: ws.repoPath });
  if (worktrees.some((w) => resolve(expandPath(w.path, this.home)) === dir))
    return;
  await worktreeAdd({
    path: ws.repoPath,
    dir,
    branch: ws.branch,
    base: ws.base,
  });
}
