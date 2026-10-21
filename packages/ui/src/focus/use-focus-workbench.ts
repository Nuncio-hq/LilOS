import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { readWbCache } from "../lib/wb-probe-cache";
import type {
  EmpFn,
  HostAccessors,
  Reply,
  Thread,
  WbSpot,
  WbTab,
  Work,
} from "../types";
import { sessionArtifacts } from "../workbench/artifacts";
import { threadPlans } from "../workbench/plan-panel";
import { sessionSubagents } from "../workbench/subagents-panel";

/* The session view's Workbench state: whether the panel is open, which tab it
   shows, whether it follows the agent, and whether it has anything to offer.
   FocusView owns the panel's element; this is every rule about WHEN it opens
   and WHICH tab it lands on — one place, because the rules lean on each other
   (a pick disarms follow, a deep link holds it, a new turn re-arms it). */
export interface FocusWorkbench {
  tab: WbTab;
  /** The user's pick (also a link's / the strip's): opens the panel there and
      stops following the agent. */
  pickTab: (t: WbTab) => void;
  wbOpen: boolean;
  /** The wanted open state, read at render: an unrelated render landing while
      a deferred setWbOpen is pending must not re-hide a panel just opened. */
  wbOpenWanted: { current: boolean };
  /** True from the first open on — the aside mounts then and is hidden, not
      unmounted, when closed. */
  wbEverOpened: { current: boolean };
  wbClose: () => void;
  /** Whether the panel has anything to show (the strip and the aside render
      only then, D-#19). */
  wbAvailable: boolean;
  /** The Workbench reports its settled tab set. */
  setWbReported: (tabs: WbTab[] | null) => void;
  /** The turn in flight, if any. */
  live: Reply | undefined;
}

export function useFocusWorkbench({
  thread,
  work,
  host,
  isDM,
  emp,
  running,
  initialTab,
  onTab,
  wbSpot,
  engineHandlers,
}: {
  thread: Thread;
  work: Work | null;
  host?: HostAccessors;
  isDM: boolean;
  emp: EmpFn;
  running: boolean;
  initialTab?: WbTab;
  onTab?: (t: WbTab) => void;
  wbSpot?: WbSpot;
  /** The host handles Background (a `background_jobs` capability): a
      folderless session then has an engine tab to offer. */
  engineHandlers: boolean;
}): FocusWorkbench {
  /* A `?tab=` destination shows its tab even under lg, where the panel is
     an overlay — "open on Subagents" means visibly open (#319 AC-1).
     Auto-open at ≥lg only when the panel has something to show on entry: a
     folder (or a non-DM thread's mock tabs), or live engine work on a
     folderless session (#543 — auto-opening an empty Background tab on
     every folderless Focus is noise, and under lg the overlay would sit
     over the ask card). */
  const engineContent =
    (thread.jobs?.length ?? 0) > 0 ||
    sessionSubagents(thread).length > 0 ||
    threadPlans(thread).length > 0;
  const [wbOpen, setWbOpen] = useState(
    () =>
      (window.innerWidth >= 1024 && (work != null || !isDM || engineContent)) ||
      initialTab !== undefined,
  );
  /* #547 AC-5: closing the panel hides the aside (display:none) instead of
     unmounting it. On a big repo the remount is the whole reopen cost
     (~220 ms shell + ~0.3 ms/row) — keeping the DOM makes reopen a class
     flip. `wbEverOpened` mounts on first open only, and the element the view
     builds is memoized so a wbOpen toggle doesn't re-render the tree (its
     props are unchanged). Focus remounts still unmount — the wb-probe-cache
     covers those. */
  const wbEverOpened = useRef(wbOpen);
  if (wbOpen) wbEverOpened.current = true;
  /* The visibility flip lands synchronously: the React re-render that
     re-asserts the same `hidden` class costs ~100 ms on a big repo, and
     the user shouldn't wait for it to see the panel (#547 AC-5). Every
     setWbOpen call site goes through this so state and DOM agree. The
     state update itself rides a transition so it renders off the click's
     critical path — the imperative class flip paints first. */
  const wbOpenWanted = useRef(wbOpen);
  const wbFlip = useCallback((open: boolean) => {
    /* `wbOpen` inside a handler can be stale while a transition is still
       rendering — the ref tracks the wanted value at click time so rapid
       close→open clicks never toggle the wrong way (#547). The DOM class
       flips synchronously (the user's frame); the state update waits a
       frame so the ~65 ms FocusView re-render can't delay first paint. */
    wbOpenWanted.current = open;
    /* Converge to the LATEST wanted value at fire time — a rapid
       close→open→close leaves several timers queued and only the final
       wanted state is correct. */
    setTimeout(() => setWbOpen(wbOpenWanted.current), 0);
    /* `flex` and `hidden` flip together (#736): the aside's display comes
       from `flex`, which the render drops while it is `hidden` — unhiding
       alone leaves it `display:block` until the deferred re-render, a frame
       that lays the Files scroller out at its full height and clamps its
       restored scrollTop to 0. */
    const shell = document.querySelector("[data-wb-shell]");
    shell?.classList.toggle("hidden", !open);
    shell?.classList.toggle("flex", open);
  }, []);
  const wbClose = useCallback(() => wbFlip(false), [wbFlip]);
  /* #547 AC-1: a Focus remount (Esc out/in, session switch and back)
     reseeds the picked tab from the folder's cache entry — only a panel
     reopen was covered before. A `?tab=` deep link still wins. A
     cache-seeded pick counts as a pick, so follow must start disarmed —
     otherwise the lastDone/liveKey effects below re-apply "changes" on
     mount and stomp it before the first paint. */
  const cachedTab =
    work?.path && host ? readWbCache(host, work.path)?.tab : undefined;
  const [tab, setTab] = useState<WbTab>(
    () =>
      initialTab ??
      cachedTab ??
      (sessionArtifacts(thread).diffs.length ? "changes" : "terminal"),
  );
  /* Follow lives in a ref, not state: a `?tab=` deep link applying in the
     same commit as a turn's step/settle event would let the later effects
     below read the stale pre-deep-link `follow` and steal the tab it just
     applied (their setState queues after, so the steal would win). */
  const followRef = useRef(!initialTab && cachedTab == null);
  /* #547 AC-1 (cont.): `work` can arrive a render after mount (conv still
     loading) — then the mount seed above missed and the tab picked the
     heuristic ("terminal"→falls back to Changes). Seed once more when
     host+path first become available, in a layout effect so the restore
     lands before the next paint. `seededTab` also flips on any user pick
     or `?tab=` apply so a late seed never stomps a real choice. */
  const seededTab = useRef(initialTab !== undefined);
  useLayoutEffect(() => {
    if (seededTab.current || !work?.path || !host) return;
    seededTab.current = true;
    const saved = readWbCache(host, work.path)?.tab;
    if (saved != null) {
      followRef.current = false;
      setTab(saved);
    }
  }, [work?.path, host, initialTab]);
  /* Why follow is disarmed matters for the re-arm below: a `?tab=` deep
     link holds the named tab even while a still-starting turn streams in
     (#319); a manual pick or a `workbench_open` spot does not — a turn
     that begins post-attach re-engages follow there (#396). Both write
     `?tab=`, so the hold can't key on `initialTab` alone. */
  const deepLinkHold = useRef(!!initialTab);
  /* `?tab=` can land after mount — a boot redirect settling the location —
     and applies then like a fresh deep link (#432); the prop is not
     mount-only. A user pick writes the same tab back through the URL, so
     re-applying it is a no-op. */
  const appliedTab = useRef(initialTab);
  useEffect(() => {
    if (!initialTab || initialTab === appliedTab.current) return;
    appliedTab.current = initialTab;
    seededTab.current = true; // a `?tab=` apply counts as the seed (#547)
    deepLinkHold.current = true;
    setTab(initialTab);
    followRef.current = false;
    wbFlip(true);
  }, [initialTab]);
  const live = thread.replies.find((r) => r.live);
  const lastStep = live?.steps?.[live.steps.length - 1];
  const liveKey = live
    ? `${live.id}:${live.steps?.length}:${lastStep?.running}`
    : "";
  /* Follow the agent: a turn that BEGAN while this feed was attached
     re-arms follow so the workbench tracks it. The turn already live when
     the view mounted — a mid-turn reload onto `?tab=` — must not steal the
     deep-linked tab before the user ever saw it (#396). `live` arrives
     async, so the discriminator is the turn's own attach boundary
     (`postAttach`), not mount-time state; mock rows without it keep the
     old always-follow behavior. Under `deepLinkHold` (`?tab=` applied,
     not yet picked away) a still-starting turn must NOT re-arm — its
     `turn.started` landing post-attach would let `liveKey` steal the
     deep-linked tab on the next step (#319). */
  /* Re-arm only when a NEW turn appears while mounted: the mount-run must
     not fire for a turn already streaming when the view attached — on a
     Focus remount that would re-engage follow and let liveKey steal the
     cache-seeded tab mid-turn (#547 AC-1). A pick made mid-turn still
     re-arms on the NEXT turn (live.turnId changes) exactly as before
     (#396). Keyed on `turnId`, not `id`: mergeTurns rewrites the live
     reply's `id` to the relay row it claims — a `message.created` that
     folds while `turn.completed` is still in flight must not read as a
     new turn and drop the pick-hold (#685). */
  const seenLive = useRef(live?.turnId ?? live?.id);
  /* #606: a pick while a turn is in flight holds follow for THAT turn —
     its `live` row can land after the pick (`turn.started` rides the feed),
     and `seenLive` alone can't tell the late row from a new turn's. The
     stamp lifts on the first quiet beat (nothing live or running — the
     pick-time turn ended) or when a different live turn shows up, so the
     next turn still re-engages follow (#396). "in-flight" = running but
     the row hasn't rendered yet. */
  const pickedDuringTurn = useRef<string | null>(null);
  useEffect(() => {
    const id = live?.turnId ?? live?.id;
    if (id === seenLive.current) return;
    seenLive.current = id;
    /* The first live row after a mid-turn pick IS the pick-time turn —
       keep holding; a different id is a new turn and lifts the hold. */
    if (id && pickedDuringTurn.current != null) {
      pickedDuringTurn.current =
        pickedDuringTurn.current === "in-flight" ||
        pickedDuringTurn.current === id
          ? id
          : null;
    }
    if (
      !deepLinkHold.current &&
      pickedDuringTurn.current == null &&
      live &&
      live.postAttach !== false
    )
      followRef.current = true;
  }, [live?.turnId ?? live?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!running && !live) pickedDuringTurn.current = null;
  }, [running, live]);
  // Turn finished with edits → land on Changes, like Codex's review pane.
  const lastDone = [...thread.replies]
    .reverse()
    .find((r) => emp(r.from) && !r.live);
  useEffect(() => {
    if (followRef.current && !live && lastDone?.steps?.some((s) => s.diff))
      setTab("changes");
  }, [lastDone?.id, !!live]); // eslint-disable-line react-hooks/exhaustive-deps
  // A PR NEWLY appearing on the session opens its tab (Devin opens a PR tab
  // per PR) — a change only: re-opening a conversation that already has one
  // must not flip the panel open on its own (#579).
  const seenPr = useRef<number | undefined>(undefined);
  useEffect(() => {
    const n = thread.pr?.number;
    if (seenPr.current === undefined) {
      seenPr.current = n;
      return;
    }
    if (n !== undefined && n !== seenPr.current) {
      setTab("pr");
      wbFlip(true);
    }
    seenPr.current = n;
  }, [thread.pr?.number]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!followRef.current || !lastStep) return;
    if (lastStep.diff) setTab("changes");
    else if (lastStep.tool === "terminal") setTab("terminal");
  }, [liveKey]); // eslint-disable-line react-hooks/exhaustive-deps
  /* The running turn spins off a new helper → Subagents comes forward (#317). */
  const liveHelpers = live?.subagents?.map((x) => x.id).join(",") ?? "";
  useEffect(() => {
    if (followRef.current && liveHelpers) setTab("subagents");
  }, [liveHelpers]); // eslint-disable-line react-hooks/exhaustive-deps
  /* Latest in-flight turn, read at pick time — riding a ref keeps the
     memoized `pickTab` stable across step churn (the actsRef pattern).
     `turnId` survives the relay-claim id rewrite (#685). */
  const inFlightTurn = useRef<{ turnId?: string } | null>(null);
  inFlightTurn.current = live ?? (running ? {} : null);
  const pickTab = useCallback(
    (t: WbTab) => {
      setTab(t);
      /* The pick belongs to the turn currently in flight — hold follow for
         it specifically (#606): a live row arriving after the pick is that
         same turn, not a new one. */
      pickedDuringTurn.current = inFlightTurn.current
        ? (inFlightTurn.current.turnId ?? "in-flight")
        : null;
      seededTab.current = true; // a manual pick counts as the seed (#547)
      followRef.current = false;
      /* A pick lifts the deep-link hold (new turns re-arm follow) and its
         `?tab=` echo must not re-mark the hold — record it as applied so
         the effect above treats the echo as a no-op. */
      deepLinkHold.current = false;
      appliedTab.current = t;
      wbFlip(true);
      onTab?.(t);
    },
    [onTab, wbFlip],
  );
  /* #340 AC-2b: `workbench_open` brings the panel forward on the target's
     tab — the Workbench applies `target`; here the panel opens and follow
     stops (it is the agent's explicit "look at this"). */
  const wbSpotAt = wbSpot?.at;
  useEffect(() => {
    if (!wbSpot) return;
    wbFlip(true);
    followRef.current = false;
    deepLinkHold.current = false;
  }, [wbSpotAt]); // eslint-disable-line react-hooks/exhaustive-deps
  /* #543: the Workbench exists for EVERY session — the app passes `host`
     unconditionally now (the accessors are folder-independent; every call
     takes the cwd). Folder-bound tabs still need a real folder — that's
     per-tab inside the Workbench. The work strip renders only when a tab
     could show (D-#19): a folder session can always ask the host; a folderless
     session needs an engine tab (a declared background_jobs capability via
     `onStopJob`, jobs, helpers, a plan — or the `?tab=subagents` deep
     link); a channel thread keeps its mock tabs. Once opened, the
     Workbench reports its settled tab set — a folder session whose host
     answered nothing and has no engine work reports empty, which hides the
     strip (AC-5) — except while the panel is already open, where its
     "Nothing to show" line answers instead of a vanishing aside. */
  const [wbReported, setWbReported] = useState<WbTab[] | null>(null);
  useEffect(() => {
    setWbReported(null);
  }, [thread.session, work?.path]);
  const engineTabs = engineContent || engineHandlers;
  const wbAvailable =
    host != null &&
    (wbReported === null
      ? work != null || !isDM || engineTabs || tab === "subagents"
      : wbReported.length > 0 || engineTabs || tab === "subagents" || wbOpen);
  return {
    tab,
    pickTab,
    wbOpen,
    wbOpenWanted,
    wbEverOpened,
    wbClose,
    wbAvailable,
    setWbReported,
    live,
  };
}
