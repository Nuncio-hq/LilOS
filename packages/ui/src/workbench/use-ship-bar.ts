import { type RefObject, useEffect, useState } from "react";
import { draftKey, useDraft } from "../lib/drafts";
import type { WbProbeData } from "../lib/wb-probe-cache";
import type {
  Diff,
  Employee,
  GitCommit,
  HostAccessors,
  ShipBar,
  ShipBusy,
  ShipError,
  ShipHandlers,
  Thread,
  WbTab,
  Work,
} from "../types";

/* The commit → push → Create PR bar's state (issue #107/#359). The app owns
   it; the bar itself (commit-bar.tsx) is presentational. Live mode builds the
   handlers from the host's git.* + forge.* accessors, one per method that
   answered (D-#19); without a host the prototype's `ship` seam supplies them. */

export type ShipBarState = {
  shipBar: (ShipBar & ShipHandlers) | null;
  /** Paths the user unticked — the bar commits the rest (all ticked at first). */
  unchecked: ReadonlySet<string>;
  toggleFile: (path: string, on: boolean) => void;
  /** Commits for the Commits section + PR prefill. */
  commits: GitCommit[];
};

export function useShipBar({
  thread,
  work,
  lead,
  liveMode,
  host,
  liveCwd,
  probe,
  diffs,
  stepCommits,
  ship,
  onSend,
  onSuggest,
  setTab,
  updateProbe,
}: {
  thread: Thread;
  work: Work | null;
  lead?: Employee;
  liveMode: boolean;
  host?: HostAccessors;
  liveCwd?: string;
  probe: WbProbeData | null;
  diffs: Diff[];
  /** Commits the steps carried (the fallback before `git.log` answers). */
  stepCommits: GitCommit[];
  ship?: Partial<ShipBar> & ShipHandlers;
  onSend?: (t: string) => void;
  onSuggest?: (
    files: string[],
  ) => Promise<string | undefined | void> | string | undefined | void;
  setTab: (t: WbTab) => void;
  /** Re-reads the folder after a write so Changes / Commits / PR follow it. */
  updateProbe: RefObject<(() => Promise<void>) | null>;
}): ShipBarState {
  /* Which host methods exist — the bar's controls render only for the ones
     in this set (D-#19, AC-6); null while host.describe hasn't answered. */
  const [shipMethods, setShipMethods] = useState<Set<string> | null>(null);
  useEffect(() => {
    let off = false;
    if (liveMode && host?.methods) {
      void host
        .methods()
        .then((m) => !off && setShipMethods(m))
        .catch(() => {});
    } else setShipMethods(null);
    return () => {
      off = true;
    };
  }, [liveMode, host]);
  const shipHas = (m: string) => shipMethods?.has(m) ?? false;

  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  /* The commit-message box is a `lilos:` draft keyed on the session (#584
     AC-2): a Suggest answer (or typed text) survives a reload exactly like
     a composer draft. */
  const [commitMsg, setCommitMsg] = useDraft(
    thread.session ? draftKey.commit(thread.session) : undefined,
  );
  const [shipBusy, setShipBusy] = useState<ShipBusy>(null);
  const [shipError, setShipError] = useState<ShipError | null>(null);
  /* Upstream a push in this view landed on — the bar's ↑ chip (issue #393
     AC-6; a fresh mount leaves the chip off until the next push). */
  const [pushedUp, setPushedUp] = useState<string | null>(null);
  const checkedPaths = diffs
    .map((d) => d.path)
    .filter((p) => !unchecked.has(p));
  const toggleFile = (path: string, on: boolean) =>
    setUnchecked((s) => {
      const n = new Set(s);
      if (on) n.delete(path);
      else n.add(path);
      return n;
    });
  /* The host's typed failure rides `error.data` ({reason, detail}); anything
     else reads as its message. */
  const shipErrorOf = (e: unknown): ShipError => {
    const data =
      e && typeof e === "object" && "data" in e && e.data ? e.data : undefined;
    const reason =
      data && typeof data === "object" && "reason" in data
        ? (data.reason as ShipError["reason"])
        : undefined;
    const detail =
      data &&
      typeof data === "object" &&
      "detail" in data &&
      typeof data.detail === "string"
        ? data.detail
        : undefined;
    return { reason, detail, text: e instanceof Error ? e.message : String(e) };
  };
  /* Runs a ship action: busy + error state, then a probe refresh so the list
     / Commits / PR tab reflect the write without waiting for a turn flip.
     The action's own value (e.g. a Suggest answer) is returned to the bar. */
  const shipCall = async <T>(
    stage: ShipBusy,
    fn: () => Promise<T>,
  ): Promise<T> => {
    setShipBusy(stage);
    setShipError(null);
    try {
      const v = await fn();
      await updateProbe.current?.();
      return v;
    } catch (e) {
      setShipError(shipErrorOf(e));
      throw e;
    } finally {
      setShipBusy(null);
    }
  };
  /* #584: Suggest is a side ask, not a send — the app forwards it to the
     engine's `session.ask`; shipCall's funnel gives it the same busy/error
     surface as the other actions. */
  const suggest =
    onSuggest != null
      ? () =>
          shipCall("suggest", () => Promise.resolve(onSuggest(checkedPaths)))
      : undefined;

  /* Live-mode ship handlers — one per host method that answered (D-#19). */
  const liveShip: ShipHandlers = {};
  if (liveMode && host && liveCwd) {
    const cwd = liveCwd;
    if (shipHas("git.commit") && host.commit) {
      liveShip.onCommit = (files, message) =>
        shipCall("commit", async () => {
          await host.commit?.(cwd, files, message);
          setCommitMsg("");
          setUnchecked(new Set());
        });
    }
    if (shipHas("git.push") && host.push) {
      const push = host.push;
      liveShip.onPush = () =>
        shipCall("push", async () => {
          setPushedUp((await push(cwd)).upstream);
        });
    }
    /* #393 AC-5: git.pull (`pull --ff-only`) is the fix the rejected-push
       copy names; a diverged history surfaces its typed reason plainly. */
    if (shipHas("git.pull") && host.pull) {
      const pull = host.pull;
      liveShip.onPull = () => shipCall("pull", () => pull(cwd));
    }
    if (onSend != null) {
      liveShip.onAskAgent = () =>
        onSend(
          `The push was rejected — the remote has newer commits on ${probe?.status?.branch ?? "this branch"}. Please update the branch with the remote's latest commits, then push again.`,
        );
    }
    if (suggest != null) liveShip.onSuggest = suggest;
    if (shipHas("forge.create") && host.prCreate) {
      liveShip.onCreatePr = (p) =>
        shipCall("pr", async () => {
          /* On the default branch the form supplied a new branch name —
             branch first (carrying the commits), then push, then create. */
          if (p.branch) {
            if (!(shipHas("git.createBranch") && host.createBranch)) {
              throw new Error(
                "this host can't create branches — git.createBranch is not advertised",
              );
            }
            await host.createBranch(cwd, p.branch);
          }
          if (shipHas("git.push") && host.push)
            setPushedUp((await host.push(cwd)).upstream);
          await host.prCreate?.(cwd, {
            title: p.title,
            body: p.body,
            base: probe?.branches?.default ?? undefined,
          });
          /* No extra re-read: shipCall's trailing `update()` lands the
             fresh PR, and landing on the PR tab signals its own read —
             a reloadPr here would double-call `gh pr view` (#429).
             The tab switch itself waits until that refresh returns
             (#814): doing it here showed the PR while git status still
             said the default branch, so the next Create PR asked for a
             branch name again. */
        }).then(() => setTab("pr"));
    }
  }

  /* Commits for the Commits section + PR prefill: the live `git.log`
     supersedes step-derived commits once it answers (AC-5); a mock
     override arrives via `ship.commits`. */
  const commits: GitCommit[] = liveMode
    ? (probe?.log ?? stepCommits)
    : (ship?.commits ?? stepCommits);

  const shipBar: (ShipBar & ShipHandlers) | null = (() => {
    const shipFiles = diffs.map((d) => ({
      path: d.path,
      checked: !unchecked.has(d.path),
    }));
    if (liveMode) {
      /* AC-6: only in a repo (status answered) and only where a handler
         exists — a partial host surfaces just the controls it supports. */
      if (probe?.status == null) return null;
      if (!liveShip.onCommit && !liveShip.onPush && !liveShip.onCreatePr) {
        return null;
      }
      return {
        isRepo: true,
        branch: probe.status.branch,
        defaultBranch: probe.branches?.default ?? null,
        remote: probe.branches?.remote ?? null,
        files: shipFiles,
        commits,
        message: commitMsg,
        busy: shipBusy,
        error: shipError,
        upstream: pushedUp,
        employeeName: lead?.name,
        onMessage: setCommitMsg,
        onSuggest: suggest,
        ...liveShip,
      };
    }
    /* #393 AC-7: a read-only thread (no session folder yet) with no
       changes keeps Start work as the single path — no dead ship bar. */
    if (!work && diffs.length === 0) return null;
    if (!ship) return null;
    return {
      isRepo: ship.isRepo ?? true,
      branch: ship.branch ?? work?.branch ?? null,
      defaultBranch: ship.defaultBranch ?? null,
      remote: ship.remote,
      files: shipFiles,
      commits: ship.commits ?? stepCommits,
      message: commitMsg,
      busy: shipBusy,
      error: shipError,
      upstream: ship.upstream ?? null,
      accessory: ship.accessory,
      employeeName: ship.employeeName ?? lead?.name,
      onMessage: setCommitMsg,
      onSuggest:
        (ship.onSuggest &&
          (() =>
            shipCall("suggest", () => Promise.resolve(ship.onSuggest!())))) ??
        suggest,
      onCommit: ship.onCommit
        ? (files, message) =>
            shipCall("commit", async () => {
              await ship.onCommit!(files, message);
              setCommitMsg("");
              setUnchecked(new Set());
            })
        : undefined,
      onPush: ship.onPush
        ? () => shipCall("push", () => ship.onPush!())
        : undefined,
      onPull: ship.onPull
        ? () => shipCall("pull", () => ship.onPull!())
        : undefined,
      onAskAgent:
        ship.onAskAgent ??
        (onSend
          ? () =>
              onSend(
                "The push was rejected — the remote has newer commits on this branch. Please update the branch with the remote's latest commits, then push again.",
              )
          : undefined),
      onCreatePr: ship.onCreatePr
        ? (p) => shipCall("pr", () => ship.onCreatePr!(p))
        : undefined,
    };
  })();

  return { shipBar, unchecked, toggleFile, commits };
}
