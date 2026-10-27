import { existsSync, promises as fsp } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { Ask, Conversation } from "@lilos/contracts/app";
import {
  expandPath,
  forgePrs,
  HostError,
  worktreeEnsure,
  worktreeRemove,
} from "@lilos/host";
import type { HarnessCtx } from "./ctx";

/**
 * D-#881: a settled thread gives its hand-off copy back. The relay owns
 * "settled" (D-#862); this module reacts to the `conversation.updated`
 * the stamp rides on: when the thread's `cwd` is a `.lilos/wt` worktree of
 * its `workspace.repoPath` and nothing can still run there — no live turn,
 * no send in flight, no open ask, no OTHER live thread inside the same
 * folder — `worktreeRemove` does the safe git side and one quiet system
 * line reports the verdict on the thread.
 *
 * A running turn, open ask or folder-sharer SKIPS without marking the
 * settle handled — the next row update (the turn finishing writes
 * `state:"idle"`, the ask resolving touches the row) retries the whole
 * check. Un-settle re-materializes the copy when it's gone — "dir missing
 * and thread is live", not a marker, so an un-settle that lands MID-
 * cleanup still rebuilds behind the cleanup link on the same chain
 * (`sendPrompt` waits that chain out). Settles the host slept through
 * never emit an event, so `onRelayReady` scans the rows once per
 * register. Every check reads the conversations ATOM — its writer runs
 * synchronously after the listener that queued the chain, so by chain
 * time it holds the newest stamp; a relay list is only the fallback for
 * a row the atom never saw.
 */

/** `dir` under `<repo>/.lilos/wt/`, both sides canonicalized — `conv.cwd`
    may carry `~` or a symlinked parent while `worktree list` prints
    realpaths; an already-removed dir canonicalizes through its parent. */
async function canonPath(p: string, home: string): Promise<string> {
  const abs = resolve(expandPath(p, home));
  return await fsp.realpath(abs).catch(async () => {
    const parent = await fsp.realpath(join(abs, "..")).catch(() => undefined);
    return parent ? join(parent, basename(abs)) : abs;
  });
}

export async function lilosWorktreeDir(
  ctx: HarnessCtx,
  conv: Conversation,
): Promise<{ repo: string; dir: string } | undefined> {
  const ws = conv.workspace;
  if (!ws?.repoPath || !conv.cwd) return undefined;
  const repoRaw = resolve(expandPath(ws.repoPath, ctx.home));
  const repo = await fsp.realpath(repoRaw).catch(() => repoRaw);
  const dir = await canonPath(conv.cwd, ctx.home);
  /* A DIRECT child only — a thread filed on a subfolder inside a
     worktree is not the worktree's owner (a sharer can be, a deeper
     path never); its settle is none of the cleanup's business. */
  const under = (r: string) => {
    const wt = join(r, ".lilos", "wt") + sep;
    return dir.startsWith(wt) && !dir.slice(wt.length).includes(sep);
  };
  return under(repo) || under(repoRaw) ? { repo, dir } : undefined;
}

/** The live row — the atom first (updated in the same synchronous
    dispatch that queued this chain), the relay's list only when the row
    is one the atom never saw. */
async function liveConversation(
  ctx: HarnessCtx,
  conversationId: string,
): Promise<{ conv?: Conversation; list: Conversation[] }> {
  const atom = ctx.opts.relay.conversations.get();
  const found = atom.find((c) => c.id === conversationId);
  if (found) return { conv: found, list: atom };
  const { conversations } = await ctx.opts.relay.request<{
    conversations: Conversation[];
  }>("conversations.list", { includeArchived: true });
  return {
    conv: conversations.find((c) => c.id === conversationId),
    list: conversations,
  };
}

/** The merged PR a squash merge left behind (forge.prs `headRefOid`) —
    the worktree's proof its commits landed, and the number the
    gone-note names. `gh` on a non-GitHub remote errors — a repo without
    a forge just answers "no merged PR". */
export async function mergedPrFor(
  repoPath: string,
  branch: string,
): Promise<{ oid: string; pr: number } | undefined> {
  try {
    const { prs } = await forgePrs({ path: repoPath, branches: [branch] });
    const merged = prs.find((p) => p.state === "merged" && p.headOid);
    return merged?.headOid !== undefined
      ? { oid: merged.headOid, pr: merged.number }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The note a thread hears when its branch is gone local and remote —
    names the merged PR when the forge proves one deleted it (D-#881:
    the user answers "continue in the repo folder" by moving the thread
    themselves — the host never silently forks). */
export async function goneBranchNote(
  repoPath: string,
  branch: string,
): Promise<string> {
  const merged = await mergedPrFor(repoPath, branch);
  return merged?.pr !== undefined
    ? `This thread's branch was merged and deleted (PR #${merged.pr}). Continue in the repo folder?`
    : `The worktree can't come back — branch ${branch} is gone locally and on the remote. Move the thread's folder to keep working.`;
}

async function doCleanup(ctx: HarnessCtx, conversationId: string) {
  const { conv: live, list } = await liveConversation(ctx, conversationId);
  const ws = live?.workspace;
  if (!live || live.settledAt === undefined || !ws) return;
  if (ctx.worktreeCleaned.get(live.id) === live.settledAt) return;
  const target = await lilosWorktreeDir(ctx, live);
  /* Only LilOS-made copies go back — the host re-checks on realpaths, so
     this is the cheap pre-filter, not the guard. */
  if (!target) return;
  const binding = ctx.bindings.get(live.id);
  /* Nothing may still run in the copy: a live turn, a send anywhere in
     the queue→prompt window, a bind in flight — and an open ask, read
     from the relay (the row is truth; a rebind could have lost memory). */
  if (
    live.state === "active" ||
    binding?.runningTurnId ||
    ctx.sendCanProduceTurn(live.id)
  ) {
    return;
  }
  /* Another thread parked INSIDE this folder blocks while it can still
     run there — settled or not: a thread settled mid-turn loses the
     folder under its own running turn, which is exactly the loss this
     guard exists for. Path first (cheap), then the same activity tests
     the thread itself gets — a running turn, a send that can still
     produce one, an open ask. */
  for (const other of list) {
    if (other.id === live.id || !other.cwd) continue;
    const cwd = await canonPath(other.cwd, ctx.home);
    if (cwd !== target.dir && !cwd.startsWith(`${target.dir}${sep}`)) {
      continue;
    }
    const otherBinding = ctx.bindings.get(other.id);
    if (
      other.settledAt === undefined ||
      other.state === "active" ||
      otherBinding?.runningTurnId ||
      ctx.sendCanProduceTurn(other.id)
    ) {
      return;
    }
    const { asks: open } = await ctx.opts.relay.request<{ asks: Ask[] }>(
      "asks.list",
      { conversationId: other.id, state: "open" },
    );
    if (open.length > 0) return;
  }
  const { asks } = await ctx.opts.relay.request<{ asks: Ask[] }>("asks.list", {
    conversationId: live.id,
    state: "open",
  });
  if (asks.length > 0) return;
  /* The destructive call gets one last row read — an un-settle that
     landed during the ask round-trip wins. */
  if (ctx.conversationFromAtom(live.id)?.settledAt !== live.settledAt) {
    return;
  }
  const line = (text: string) =>
    ctx.postSystem(
      { channelId: live.channelId, conversationId: live.id },
      text,
      `sys:${live.id}:worktree-clean:${live.settledAt}`,
    );
  try {
    const r = await worktreeRemove({
      path: ws.repoPath,
      dir: target.dir,
      branch: ws.branch,
      mergedHeadForBranch: () => mergedPrFor(ws.repoPath, ws.branch),
    });
    if (!r.removed) {
      const count = (n?: number, one = "file") =>
        n === undefined ? "" : ` (${n} ${one}${n === 1 ? "" : "s"})`;
      const why =
        r.kept === "dirty"
          ? `it has unsaved or unpushed changes${count(r.count)}`
          : r.kept === "unpushed"
            ? `it has unsaved or unpushed changes${count(r.count, "unpushed commit")}`
            : r.kept === "ignored"
              ? `it has ignored files (${r.detail})`
              : r.kept === "head"
                ? (r.detail ?? "its checkout changed")
                : r.detail === "not inside .lilos/wt"
                  ? `${live.cwd} isn't inside .lilos/wt — not removing`
                  : `${live.cwd} isn't a registered worktree`;
      await line(`Kept the worktree: ${why}`);
    } else {
      await line(
        `Worktree cleaned up${r.branchDeleted ? " (branch merged)" : ""}`,
      );
    }
  } catch (error) {
    ctx.opts.log.warn("worktree cleanup failed", {
      conversationId: live.id,
      error: String(error),
    });
    await line(
      `Couldn't clean the worktree — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  ctx.worktreeCleaned.set(live.id, live.settledAt);
}

export async function cleanupSettledWorktree(
  this: HarnessCtx,
  conv: Conversation,
): Promise<void> {
  if (conv.settledAt === undefined) {
    /* Un-settled (or never was). Restore needs no marker — "the dir is
       missing and the thread is live" is the whole condition, so an
       un-settle that landed mid-cleanup still rebuilds behind the
       cleanup link on this same chain. `sendPrompt` waits out the chain
       and `bindConversation` runs its own ensure; a gone branch gets
       the merged-PR note here for still-bound threads, the bind path
       posts the same note (same dedupe key) for ones that re-bind. */
    const ws = conv.workspace;
    if (!ws?.repoPath || !conv.cwd) return;
    const prev = this.worktreeCleanup.get(conv.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      const cur = this.conversationFromAtom(conv.id);
      /* Still settled (a settle landed after the un-settle) or moved —
         the cleanup owns it then, not us. And a never-BOUND thread's
         folder is the bind's job — its own ensureWorktree is mid-flight
         the moment the first row update lands here; racing it reads a
         not-yet-created branch as "gone" and lies on the thread. */
      if (!cur || cur.settledAt !== undefined || !cur.engineRef) return;
      const target = await lilosWorktreeDir(this, cur);
      if (!target || existsSync(target.dir)) return;
      try {
        /* The host call, not `ensureWorktree` — that wrapper waits out
           this very chain. No base: a restore never reinvents. */
        await worktreeEnsure({
          path: ws.repoPath,
          dir: target.dir,
          branch: ws.branch,
        });
      } catch (error) {
        this.opts.log.warn("worktree restore failed", {
          conversationId: conv.id,
          error: String(error),
        });
        const gone =
          error instanceof HostError &&
          (error.data as { reason?: string } | undefined)?.reason === "gone";
        /* The dedupe key carries the settle stamp — a LATER settle
           cycle's note is its own incident, never swallowed by an
           earlier key. */
        void this.postSystem(
          { channelId: conv.channelId, conversationId: conv.id },
          gone
            ? await goneBranchNote(ws.repoPath, ws.branch)
            : `The worktree can't come back — ${error instanceof Error ? error.message : String(error)}`,
          `sys:${conv.id}:worktree:${this.worktreeCleaned.get(conv.id) ?? 0}`,
        );
      }
    });
    this.worktreeCleanup.set(
      conv.id,
      next.catch(() => {}),
    );
    await next;
    return;
  }
  const own =
    this.worktreeCleaned.get(conv.id) !== conv.settledAt &&
    (await lilosWorktreeDir(this, conv)) !== undefined;
  /* Serialize per thread: settle/un-settle bursts and a turn finishing
     mid-cleanup queue here, each link re-reading the live row inside.
     Every settle chains — even a folder-sharer with no worktree of its
     own, since ITS settling may release a sibling's copy. */
  const prev = this.worktreeCleanup.get(conv.id) ?? Promise.resolve();
  const next = prev.then(async () => {
    if (own) await doCleanup(this, conv.id);
    /* This settle may have retired the LAST sharer of another settled
       thread's copy (a folder-sharer blocks cleanup while it lives).
       Re-check every settled row still unhandled — each one's stamp
       dedupes a real no-op. Each sibling's cleanup goes on ITS OWN
       chain: an un-settle landing mid-remove then queues its restore
       behind the remove and the folder comes back — run inline here it
       would race this chain and the sibling could find its live thread
       staring at a deleted folder. Fire-and-forget: awaiting a sibling
       chain while it awaits ours is a circular wait. */
    for (const other of this.opts.relay.conversations.get()) {
      if (other.id === conv.id || other.settledAt === undefined) continue;
      if (this.worktreeCleaned.get(other.id) === other.settledAt) continue;
      void this.cleanupSettledWorktree(other).catch((error) =>
        this.opts.log.warn("sibling worktree cleanup failed", {
          conversationId: other.id,
          error: String(error),
        }),
      );
    }
  });
  this.worktreeCleanup.set(
    conv.id,
    next.catch(() => {}),
  );
  await next;
}
