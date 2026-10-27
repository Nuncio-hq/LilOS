import { promises as fsp } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { Ask, Conversation } from "@lilos/contracts/app";
import {
  expandPath,
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
 * no send in flight, no open ask — `worktreeRemove` does the safe git side
 * and one quiet system line reports the verdict on the thread.
 *
 * A running turn or open ask SKIPS without marking the settle handled —
 * the next row update (the turn finishing writes `state:"idle"`, the ask
 * resolving touches the row) retries the whole check. Un-settle clears
 * the marker so a later settle cleans again, and re-materializes the
 * worktree first when the cleanup actually took it (`sendPrompt` waits
 * out that restore chain so a fresh send never prompts into a deleted
 * folder). Settles the host slept through never emit an event, so
 * `onRelayReady` scans the rows once per register. Every check reads the
 * LIVE row inside the chain — a settle→un-settle burst makes the queued
 * event snapshot stale, and the row is the truth.
 */

/** `dir` under `<repo>/.lilos/wt/`, both sides canonicalized — `conv.cwd`
    may carry `~` or a symlinked parent while `worktree list` prints
    realpaths; an already-removed dir canonicalizes through its parent. */
async function isLilosWorktree(
  ctx: HarnessCtx,
  conv: Conversation,
): Promise<{ repo: string; dir: string } | undefined> {
  const ws = conv.workspace;
  if (!ws?.repoPath || !conv.cwd) return undefined;
  const repoRaw = resolve(expandPath(ws.repoPath, ctx.home));
  const repo = await fsp.realpath(repoRaw).catch(() => repoRaw);
  const abs = resolve(expandPath(conv.cwd, ctx.home));
  const dir = await fsp.realpath(abs).catch(async () => {
    const parent = await fsp.realpath(join(abs, "..")).catch(() => undefined);
    return parent ? join(parent, basename(abs)) : abs;
  });
  const under = (r: string) => {
    const wt = join(r, ".lilos", "wt") + sep;
    return dir.startsWith(wt) || abs.startsWith(wt);
  };
  return under(repo) || under(repoRaw) ? { repo, dir } : undefined;
}

async function doCleanup(ctx: HarnessCtx, conversationId: string) {
  /* The row is truth — the queued event snapshot may already be stale
     (un-settled, re-settled or moved between emit and chain). */
  const { conversations } = await ctx.opts.relay.request<{
    conversations: Conversation[];
  }>("conversations.list", { includeArchived: true });
  const live = conversations.find((c) => c.id === conversationId);
  const ws = live?.workspace;
  if (!live || live.settledAt === undefined || !ws) return;
  if (ctx.worktreeCleaned.get(live.id) === live.settledAt) return;
  const target = await isLilosWorktree(ctx, live);
  /* Only LilOS-made copies go back — a worktree the user built himself
     stays his, even when a workstream thread binds to it. */
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
  const { asks } = await ctx.opts.relay.request<{ asks: Ask[] }>("asks.list", {
    conversationId: live.id,
    state: "open",
  });
  if (asks.length > 0) return;
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
    });
    if (!r.removed) {
      const count = (n?: number, one = "file") =>
        n === undefined ? "" : ` (${n} ${one}${n === 1 ? "" : "s"})`;
      const why =
        r.kept === "dirty"
          ? `it has unsaved or unpushed changes${count(r.count)}`
          : r.kept === "unpushed"
            ? `it has unsaved or unpushed changes${count(r.count, "unpushed commit")}`
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
    /* Un-settled (or never was) — a later settle must clean fresh. When
       the cleanup answered a settle here, the copy went back: the user's
       un-settle (or the new message that caused it) re-materializes the
       worktree BEFORE the next turn — `sendPrompt` waits out this chain
       and `bindConversation` runs its own ensure. A gone branch gets a
       quiet note here for still-bound threads; the bind path posts the
       same note for ones that re-bind. */
    const wasCleaned = this.worktreeCleaned.delete(conv.id);
    const ws = conv.workspace;
    if (!wasCleaned || !ws || !conv.cwd) return;
    const prev = this.worktreeCleanup.get(conv.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        /* The host call, not `ensureWorktree` — that wrapper waits out
           this very chain. */
        await worktreeEnsure({
          path: ws.repoPath,
          dir: conv.cwd ?? "",
          branch: ws.branch,
          ...(ws.mode === "new" ? { base: ws.base } : {}),
        });
      } catch (error) {
        this.opts.log.warn("worktree restore failed", {
          conversationId: conv.id,
          error: String(error),
        });
        /* A still-bound thread hears the restore verdict here — the bind
           path posts the same note under the same dedupe key, so one of
           the two lands. Gone branches get the actionable wording. */
        const gone =
          error instanceof HostError &&
          (error.data as { reason?: string } | undefined)?.reason === "gone";
        void this.postSystem(
          { channelId: conv.channelId, conversationId: conv.id },
          gone
            ? `The worktree can't come back — branch ${ws.branch} is gone locally and on the remote. Move the thread's folder to keep working.`
            : `The worktree can't come back — ${error instanceof Error ? error.message : String(error)}`,
          `sys:${conv.id}:worktree`,
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
  if (this.worktreeCleaned.get(conv.id) === conv.settledAt) return;
  const target = await isLilosWorktree(this, conv);
  if (!target) return;
  /* Serialize per thread: settle/un-settle bursts and a turn finishing
     mid-cleanup queue here, each link re-reading the live row inside. */
  const prev = this.worktreeCleanup.get(conv.id) ?? Promise.resolve();
  const next = prev.then(() => doCleanup(this, conv.id));
  this.worktreeCleanup.set(
    conv.id,
    next.catch(() => {}),
  );
  await next;
}
