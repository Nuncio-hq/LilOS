import { useEffect, useRef, useState } from "react";
import {
  EMPTY_WB_PROBE,
  patchWbCache,
  readWbCache,
  type WbProbeData,
  type WbViewFile,
} from "../lib/wb-probe-cache";
import type { HostAccessors, WbTab } from "../types";
import { createPrPoll, type PrPoll } from "./pr-poll";

/* e2e/dev knob — `?wbPrSigMark=1`: every signal-driven `forge.pr` decision
   taken inside the failure window (a landed `error` answer) bumps
   `data-pr-sig-mark` on the PR tabpanel — once the scheduled read has
   committed its swap pre-fix, or at the hold post-fix — so a spec can press
   Retry strictly after a scheduled `forge.pr` decision: the deterministic
   form of #720's land-vs-press race. Inert when unset; read once at module
   load like `?stubHydrateMs=`. */
export const WB_PR_SIG_MARK = (() => {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("wbPrSigMark");
})();

export type WbProbe = {
  /** The last-known reads (cache-seeded) — null until the first lands. */
  probe: WbProbeData | null;
  /** The cache entry the mount painted from, when there was one. */
  restored: ReturnType<typeof readWbCache>;
  sel: string | null;
  setSel: (p: string | null) => void;
  viewFile: WbViewFile | null;
  setViewFile: (
    v: WbViewFile | null | ((p: WbViewFile | null) => WbViewFile | null),
  ) => void;
  /** The first full read round has landed (a cache hit counts). */
  firstSettled: boolean;
  /** Cached rows showed before the fresh round settled — the "updating…" cue. */
  revalidating: boolean;
  /** `?wbPrSigMark` reproducer counter (#720). */
  prSigMark: number;
  /** A `forge.pr` answer landed by a user action (Retry, comment, merge). */
  landPr: (r: NonNullable<WbProbeData["pr"]>) => void;
  reloadPr: () => Promise<void>;
  /** Re-reads the folder (and signals the PR poll) — set while live. */
  updateProbe: React.RefObject<(() => Promise<void>) | null>;
  prPoll: React.RefObject<PrPoll | null>;
};

/** The live read of the session's folder (issue #11 fs/git, #37 forge) and
    the folder state that rides its cache: the open file view, the selected
    change, the picked tab. Reads land independently; the per-folder cache
    paints the next mount's first frame (#544). */
export function useWbProbe({
  host,
  liveMode,
  liveCwd,
  running,
  tab,
}: {
  host?: HostAccessors;
  liveMode: boolean;
  liveCwd?: string;
  running?: boolean;
  tab: WbTab;
}): WbProbe {
  /* #544: the per-folder cache (host+cwd) keeps the last-known reads
     outside this component — a remount after a panel close, an Esc out of
     Focus or a session switch paints them on the first frame while the
     mount's fresh round revalidates behind (stale-while-revalidate).
     `firstSettled` is the probe/report gate ("still probing" = the first
     full read round hasn't landed; a cache hit counts as a landed set);
     `revalidating` drives the "updating…" cue — only ever true when
     cached rows showed before the fresh round settled. */
  const [restored] = useState(() =>
    liveMode && host && liveCwd != null
      ? readWbCache(host, liveCwd)
      : undefined,
  );
  const [sel, setSel] = useState<string | null>(restored?.sel ?? null);
  const [viewFile, setViewFile] = useState<WbViewFile | null>(
    restored?.viewFile ?? null,
  );
  /* `probe` fields: files/diffs feed the Files/Changes tabs; status null =
     not a repo (AC-6 hides the ship bar); branches carries the remote
     default for the branch-name ask; log feeds Commits + the PR prefill. */
  const [probe, setProbe] = useState<WbProbeData | null>(
    restored?.probe ?? null,
  );
  /* #685: the last answer each probe key actually landed (cache-seeded) —
     a live read that answers nothing keeps it instead of blanking the
     panel it gates. Lives in a ref: `merge` runs inside an effect whose
     closure re-seats on every `running` flip. `nullStreak` bounds the
     keep: one flap rides last-known, a second consecutive null lands so
     a folder that stays gone still hides its tabs. */
  const landedProbe = useRef<Partial<WbProbeData>>({
    ...(restored?.probe ?? {}),
  });
  const landedCwd = useRef(liveCwd);
  const nullStreak = useRef<Partial<Record<keyof WbProbeData, number>>>({});
  /* `?wbPrSigMark` reproducer state (#720): counts the signal-driven
     `forge.pr` decisions made inside a failure window. */
  const [prSigMark, setPrSigMark] = useState(0);
  const [firstSettled, setFirstSettled] = useState(restored != null);
  const [revalidating, setRevalidating] = useState(restored != null);
  /* A `forge.pr` answer landed by a user action (Retry, comment, merge) —
     the same probe/cache write `merge` does for poll lands, plus the
     `landedProbe` truth that gates scheduled re-reads (#720). */
  const landPr = (r: NonNullable<WbProbeData["pr"]>) => {
    if (!host || !liveCwd) return;
    if (landedCwd.current === liveCwd) landedProbe.current.pr = r;
    patchWbCache(host, liveCwd, (e) => ({
      ...e,
      probe: { ...e.probe, pr: r },
      updatedAt: Date.now(),
    }));
    setProbe((p) => (p ? { ...p, pr: r } : p));
  };
  const reloadPr = async () => {
    if (!host?.pr || !liveCwd) return;
    const r = await host.pr(liveCwd).catch(() => null);
    if (r) landPr(r);
  };
  // Read the session folder live. While a turn runs the agent is editing —
  // a short poll keeps Changes/Files/Commits current (#114 AC-3, #107 AC-5);
  // the effect's re-run on `running` flips lands a fresh read at turn end.
  const updateProbe = useRef<(() => Promise<void>) | null>(null);
  const prPoll = useRef<PrPoll | null>(null);
  /* A different folder under the same mount drops folder-scoped state
     (open file view, selected change). #547 AC-4: the reset must NOT
     reach the NEW folder's cache entry — the write-back would push the
     outgoing selection (then the reset nulls) into it, erasing its own
     cached selection. `skipFolderWrites` counts the commits to skip: this
     one plus, when there was state to reset, the one the reset queues. */
  const prevCwd = useRef(liveCwd);
  const selRef = useRef(sel);
  selRef.current = sel;
  const viewFileRef = useRef(viewFile);
  viewFileRef.current = viewFile;
  const skipFolderWrites = useRef(0);
  useEffect(() => {
    if (prevCwd.current === liveCwd) return;
    prevCwd.current = liveCwd;
    skipFolderWrites.current =
      selRef.current != null || viewFileRef.current != null ? 2 : 1;
    setViewFile(null);
    setSel(null);
  }, [liveCwd]);
  useEffect(() => {
    if (!liveMode || !host || !liveCwd) {
      setProbe(null);
      return;
    }
    const cwd = liveCwd;
    let off = false;
    /* A folder switch under one mount drops the outgoing folder's lands —
       its answers mustn't keep the NEW folder's first-read nulls from
       landing (a dead folder still hides its tabs). Late lands from the
       stale run are guarded out of the keep bookkeeping below (their
       `patchWbCache` write stays — it lands on the right folder's entry). */
    if (landedCwd.current !== cwd) {
      landedCwd.current = cwd;
      landedProbe.current = {};
      nullStreak.current = {};
    }
    /* #814: overlapping rounds (a `running` flip restarts this effect,
       the 3s git poll, and shipCall's own refresh) must not let an
       older `git status` land after the round that saw the new branch.
       That put the Create PR form back on the default branch after the
       checkout had already moved. A later round always wins; an older
       one is dropped, including its cache write. */
    const landedGen: Partial<Record<keyof WbProbeData, number>> = {};
    let nextGen = 0;
    /* #544: reads land independently — every merge also writes the
       per-folder cache, so a land that resolves after unmount still warms
       the next mount's first frame. `pr` stays on the #429 funnel below:
       its ~1s `gh` subprocess never gates the folder tabs (AC-2). */
    /* #685: `files`/`diffs` gate their panels — a read that answers nothing
       (a transient fs/git failure; the accessor collapses errors to null)
       must NOT overwrite a landed answer. A null flap unmounts the panel —
       its scroll offset dies with the viewport — and poisons the folder
       cache (`files` null reads as "never answered", so the whole entry —
       scrolls, selection, picked tab — misses on the next mount). Same
       keep-last-known rule `forge.pr` follows below; a null FIRST read
       still lands so a dead folder hides its tab as before. */
    const merge = (patch: Partial<WbProbeData>) => {
      if (landedCwd.current === cwd) Object.assign(landedProbe.current, patch);
      patchWbCache(host, cwd, (e) => ({
        ...e,
        probe: { ...e.probe, ...patch },
        updatedAt: Date.now(),
      }));
      if (!off) setProbe((p) => ({ ...(p ?? EMPTY_WB_PROBE), ...patch }));
    };
    const keepLastKnown = (key: keyof WbProbeData) => {
      if (
        (key !== "files" && key !== "diffs") ||
        landedCwd.current !== cwd ||
        landedProbe.current[key] == null
      )
        return false;
      const streak = nullStreak.current[key] ?? 0;
      nullStreak.current[key] = streak + 1;
      return streak === 0;
    };
    const land = <K extends keyof WbProbeData>(
      key: K,
      read: Promise<WbProbeData[K] | null> | undefined,
      gen: number,
    ) =>
      (read ?? Promise.resolve(null))
        .then((v) => {
          if ((landedGen[key] ?? -1) > gen) return;
          landedGen[key] = gen;
          if (v != null) {
            if (
              (key === "files" || key === "diffs") &&
              landedCwd.current === cwd
            )
              nullStreak.current[key] = 0;
          } else if (keepLastKnown(key)) return;
          merge({ [key]: v ?? null } as Partial<WbProbeData>);
        })
        .catch(() => {
          if ((landedGen[key] ?? -1) > gen) return;
          landedGen[key] = gen;
          if (keepLastKnown(key)) return;
          merge({ [key]: null } as Partial<WbProbeData>);
        });
    const round = () => {
      const gen = ++nextGen;
      return Promise.all([
        land("files", host.tree(cwd), gen),
        land("diffs", host.diff(cwd), gen),
        land("status", host.status?.(cwd), gen),
        land("branches", host.branches?.(cwd), gen),
        land("log", host.log?.(cwd), gen),
      ]);
    };
    const updatePr = () => {
      /* #720: while the landed `forge.pr` answer is a failure, scheduled
         re-reads (the tab-shown trailing fire, an OS-window focus, a
         `running` flip, the keep-alive) hold — the failure copy's
         prescribed next step is the user's own Retry, and a `{pr}` land
         here swaps `PrFailure` → `PrPanel`, detaching the button under an
         in-flight press (ac-114's CI flake: "element is not stable" →
         "element was detached from the DOM"). The no-PR state keeps
         re-reading — it has no control a press could target. */
      if (landedProbe.current.pr?.error) {
        if (WB_PR_SIG_MARK && !off) setPrSigMark((c) => c + 1);
        return;
      }
      return host.pr?.(cwd)?.then((r) => {
        /* An unanswered `forge.pr` (outer null — unreachable, not "no
           PR") keeps the last known answer. */
        if (!r) return;
        /* The mark lands after the merge commits: a spec that waited on
           `data-pr-sig-mark` knows any subtree swap is already done. */
        const duringFailure = landedProbe.current.pr?.error != null;
        merge({ pr: r });
        if (WB_PR_SIG_MARK && !off && duringFailure) setPrSigMark((c) => c + 1);
      });
    };
    const poll = createPrPoll(() => updatePr());
    prPoll.current = poll;
    updateProbe.current = () => {
      poll.signal();
      return round().then(() => {});
    };
    /* The mount round revalidates behind whatever the cache painted;
       the report (`onAllowed`) holds until this first full round lands. */
    void round().then(() => {
      if (off) return;
      setFirstSettled(true);
      setRevalidating(false);
    });
    poll.signal(); // the initial `forge.pr` read through the same funnel
    poll.setRunning(!!running);
    const onWindowFocus = () => poll.signal();
    window.addEventListener("focus", onWindowFocus);
    const gitPoll = running ? setInterval(round, 3000) : undefined;
    /* A cached open file view re-reads behind — it stays open on
       last-known content until the fresh read lands (AC-4). */
    if (restored?.viewFile) {
      const p = restored.viewFile.path;
      void host
        .read(cwd, p)
        .then(
          (r) =>
            !off &&
            r &&
            setViewFile((v) => (v?.path === p ? { path: p, ...r } : v)),
        )
        .catch(() => {});
    }
    return () => {
      updateProbe.current = null;
      prPoll.current = null;
      poll.dispose();
      off = true;
      window.removeEventListener("focus", onWindowFocus);
      clearInterval(gitPoll);
    };
  }, [liveMode, liveCwd, running, host, restored]);
  /* The open file view + selected change + picked tab are folder state —
     write them back so a panel close/reopen (or a Focus remount, #547
     AC-1) restores them (AC-4). Skipped while a folder switch resets
     them (#547 AC-4). */
  useEffect(() => {
    if (!liveMode || !host || !liveCwd) return;
    if (skipFolderWrites.current > 0) {
      skipFolderWrites.current -= 1;
      return;
    }
    patchWbCache(host, liveCwd, (e) => ({ ...e, sel, viewFile, tab }));
  }, [sel, viewFile, tab, liveMode, liveCwd, host]);

  return {
    probe,
    restored,
    sel,
    setSel,
    viewFile,
    setViewFile,
    firstSettled,
    revalidating,
    prSigMark,
    landPr,
    reloadPr,
    updateProbe,
    prPoll,
  };
}
