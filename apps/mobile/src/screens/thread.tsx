import {
  type ChannelMessagesState,
  RelayError,
  type RelaySessionFeedState,
  reduceSessionEvents,
  sendKeyDone,
  sendKeyFor,
} from "@lilos/client-runtime";
import type {
  AppChannel,
  AppMessage,
  Conversation,
  Employee,
} from "@lilos/contracts/app";
import type { Job } from "@lilos/contracts/engine";
import type { ModelPick, PlanAction } from "@lilos/ui-native";
import {
  BackgroundSheet,
  findModel,
  modelLabel,
  PlanSheet,
  SubagentSheet,
  SubagentsSheet,
  ThreadHeaderTitle,
  ThreadInfoSheet,
  ThreadScreen,
  WbDiffSheet,
} from "@lilos/ui-native";
import { useStore } from "@nanostores/react";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { atom } from "nanostores";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, View } from "react-native";
import {
  answerPlanChange,
  awaitPlanAsk,
  decide,
  PLAN_CHANGE_PREFIX,
  planChangeSend,
} from "../asks";
import { messageCache } from "../cache";
import { $demo, DEMO_MAC } from "../demo/lifecycle";
import { defaultModelPick } from "../dm-model";
import {
  $asks,
  $catalog,
  $catalogUnavailable,
  $pendingOpens,
  $wbCards,
  refreshModelCatalog,
  watchDm,
} from "../dm-store";
import { $client, $link, $welcome } from "../link";
import { describeError } from "../mapping";
import { $connections } from "../paired-macs";
import { $prs, refreshConversationPrs } from "../prs";
import type { DmRoutes } from "../routes";
import {
  collectDiffs,
  dropRewound,
  threadSurface,
  toThreadDetail,
} from "../thread-model";

/* #157 — the live thread: messages.list + channel.subscribe resume (AC-1),
   engine turns projected live through sessionFeed -> reduceSessionEvents ->
   ThreadEntry[] (AC-2), reply/steer via messages.post (AC-3), turns.interrupt
   stop (AC-4), per-thread model pick (AC-5), the ⓘ session sheet (AC-6).
   #158: approve/deny runs asks.respond through `decide`.
   #182: plan/task cards + the plan ask (Approve / Change… / Reject), the
   Change-composer prefill, and the Plan sheet — all behind the engine's
   `plan` capability (D-#19). */

type Nav = NativeStackNavigationProp<DmRoutes>;

const $noConversations = atom<Conversation[]>([]);
const $noEmployees = atom<Employee[]>([]);
const $noChannels = atom<AppChannel[]>([]);
const $noChannel = atom<ChannelMessagesState>({
  channelId: "",
  synced: false,
  lastSeq: 0,
  messages: [],
});
const $noFeed = atom<RelaySessionFeedState>({
  conversationId: "",
  synced: false,
  latestSeq: 0,
  coverageSeq: 0,
  events: [],
  openRequests: [],
});
const $noRewinds = atom<
  Record<string, { fromSeq: number; removedIds: string[] }>
>({});

/** Everything a thread screen needs from the wire, packed for the view. */
function useThread(conversationId: string) {
  const client = useStore($client);
  const welcome = useStore($welcome);
  /* D-#19: plan rows render only when the engine declares `plan` — the same
     gate covers `subagents` (helper rows + sheet) and `background_jobs`
     (pill, sheet, Stop, the info sheet's list) (#181 AC-5). */
  const hasCap = (id: string) =>
    welcome?.engineHost?.capabilities?.some((c) => c.id === id) ?? false;
  const planCapable = hasCap("plan");
  const subagentsCapable = hasCap("subagents");
  const jobsCapable = hasCap("background_jobs");
  const conversations = useStore(client?.conversations ?? $noConversations);
  const employees = useStore(client?.employees ?? $noEmployees);
  const channels = useStore(client?.channels ?? $noChannels);
  const asks = useStore($asks);
  const pending = useStore($pendingOpens);
  const catalog = useStore($catalog);
  const catalogUnavailable = useStore($catalogUnavailable);
  const prsMap = useStore($prs);
  const wbCards = useStore($wbCards);

  /* #159 AC-5: opening the thread refetches its PRs; `turn.completed`
     refetches through watchPrs (registered by watchDm below). */
  useEffect(() => {
    if (!client) return;
    void refreshConversationPrs(client, conversationId);
  }, [client, conversationId]);

  const pendingEntry = pending.get(conversationId);
  const conv =
    conversations.find((c) => c.id === conversationId) ??
    pendingEntry?.conversation;
  const channelId = conv?.channelId;
  const chanAtom = useMemo(
    () => (client && channelId ? client.channelMessages(channelId) : undefined),
    [client, channelId],
  );
  const chanState = useStore(chanAtom ?? $noChannel);
  /* The engine feed carries the turn events; the channel subscription it
     rides is already open via channelMessages. */
  const feedAtom = useMemo(
    () => client?.sessionFeed(conversationId),
    [client, conversationId],
  );
  const feed = useStore(feedAtom ?? $noFeed);
  /* #181 AC-3/AC-4: `jobs.list` fills the rows the event stream can't carry
     (a job the engine started before a harness restart); job.* events then
     overlay by jobId — the merge is toThreadDetail's. Runs only once the
     feed synced so a replay doesn't stamp a stale overlay. */
  const engineRef = conv?.engineRef;
  const [listedJobs, setListedJobs] = useState<Job[]>([]);
  useEffect(() => {
    setListedJobs([]);
    if (!client || !jobsCapable || !engineRef || !feed.synced) return;
    let dead = false;
    const sid = engineRef;
    client
      .request<{ jobs: Job[] }>("jobs.list", { sessionId: sid })
      .then((r) => {
        if (!dead) setListedJobs(r.jobs);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [client, jobsCapable, engineRef, feed.synced]);
  /* #134 live: a rewind while this screen is open strips the tail from
     chanState but not from the fetched history — dropRewound applies the
     same cut here (removedIds for files-only rewinds, seq for the tail). */
  const rewinds = useStore(client?.rewinds ?? $noRewinds);
  const rewind = rewinds[conversationId];
  /* AC-4: key the model on the conversation's live binding (engineRef), not
     feed.sessionId — the feed's id lags a rebind, and reducing the old
     session keeps its jobs "running" (phantoms) while filtering out the new
     session's real events. Web does the same: models[conv.engineRef]. */
  const sessionModel = useMemo(() => {
    const sid = engineRef ?? feed.sessionId;
    return sid
      ? reduceSessionEvents(sid, feed.events, feed.snapshot)
      : undefined;
  }, [engineRef, feed.sessionId, feed.events, feed.snapshot]);

  /* #327: the wire carries no timestamps between turn.started and
     turn.completed, so the reasoning -> first-step/text duration is
     measured where the frames are actually watched — a turn entering
     its reasoning phase gets stamped, and the stamp accrues into
     seconds each time the phase moves on (same job web's Reasoning
     element does inside the component). Segments accumulate so a turn
     that reasons again after an open ask still counts both stretches.
     A turn replayed already past reasoning keeps no clock and the
     card falls back to "Thought". */
  const thoughtClock = useRef(new Map<string, { at?: number; acc?: number }>());
  const thoughts = useMemo(() => {
    const map = new Map<string, number>();
    const clock = thoughtClock.current;
    for (const t of sessionModel?.turns ?? []) {
      if (!t.reasoning) continue;
      let c = clock.get(t.turnId);
      if (!c) {
        c = {};
        clock.set(t.turnId, c);
      }
      if (t.phase === "reasoning") {
        c.at ??= Date.now();
      } else if (c.at !== undefined) {
        c.acc = (c.acc ?? 0) + (Date.now() - c.at);
        c.at = undefined;
      }
      if (c.acc !== undefined) {
        map.set(t.turnId, Math.max(1, Math.round(c.acc / 1000)));
      }
    }
    return map;
  }, [sessionModel]);

  const employee = conv
    ? employees.find(
        (e) =>
          e.id === channels.find((c) => c.id === conv.channelId)?.employeeId,
      )
    : undefined;

  /* AC-1: full history once via messages.list (the channel snapshot is a
     window); live frames keep appending on the subscription. #591 AC-3:
     seed from the on-device transcript first so the thread still reads
     while the socket is down — the live pull replaces it once it lands. */
  const [history, setHistory] = useState<AppMessage[]>([]);
  useEffect(() => {
    if (!client || !channelId) return;
    watchDm(client, $welcome);
    let alive = true;
    void messageCache.get(conversationId).then((cached) => {
      if (alive && cached) setHistory((cur) => (cur.length ? cur : cached));
    });
    const pull = () => {
      void client
        .request<{ messages: AppMessage[] }>("messages.list", {
          channelId,
          conversationId,
        })
        .then((res) => {
          if (!alive) return;
          setHistory(res.messages);
          void messageCache.set(conversationId, res.messages);
        })
        .catch((e) => {
          /* #591: the socket being down is not a dialog — the "Can't reach"
             line above the composer already says it. A timeout on an open
             socket is still a real failure: keep the alert. */
          if (e instanceof RelayError && e.code === "not_connected") return;
          if (alive) Alert.alert("Couldn't load the thread", describeError(e));
        });
    };
    pull();
    const unsub = client.state.listen((s) => {
      if (s === "ready") pull();
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [client, channelId, conversationId]);

  const { messages, removed: rewoundMessages } = useMemo(() => {
    const byId = new Map<string, AppMessage>();
    for (const m of history) byId.set(m.id, m);
    for (const m of chanState.messages) {
      if (m.conversationId === conversationId) byId.set(m.id, m);
    }
    /* #425: relay truth wins over the optimistic open-root — if history or
       chanState already carries the id (e.g. a tombstone arriving mid-open
       while the pending marker lives), keep that version or the stale copy
       resurrects a removed/dropped row until the engine bind clears it. */
    if (pendingEntry && !byId.has(pendingEntry.root.id))
      byId.set(pendingEntry.root.id, pendingEntry.root);
    const all = [...byId.values()].sort((a, b) => a.seq - b.seq);
    return dropRewound(all, rewind);
  }, [history, chanState.messages, conversationId, pendingEntry, rewind]);

  /* A running job ticks its uptime once a second (web's jobsTick). */
  const [jobsTick, setJobsTick] = useState(0);
  const hasRunningJob =
    !!sessionModel?.jobs.some((j) => j.status === "running") ||
    listedJobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!hasRunningJob) return;
    const t = setInterval(() => setJobsTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [hasRunningJob]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: jobsTick only re-keys `now` so a running job's uptime ticks once a second.
  const detail = useMemo(
    () =>
      conv
        ? toThreadDetail({
            conversation: conv,
            employee,
            messages,
            model: sessionModel,
            asks,
            pending: new Set(pending.keys()),
            now: Date.now(),
            models: catalog.models,
            planCapable,
            employees,
            conversations,
            jobsCapable,
            listedJobs,
            prs: prsMap[conversationId],
            thoughts,
            wbCards: wbCards[conversationId],
            /* #514: session.events answered `truncated` — the transcript's
               head is gone for good, the note says so (web: transcriptNote). */
            historyTrimmed: feed.historyTrimmed,
            rewound: {
              refs: new Set(rewind?.removedIds ?? []),
              texts: new Set(
                rewoundMessages
                  .filter((m) => m.authorKind === "employee")
                  .map((m) => m.text.trim()),
              ),
            },
          })
        : undefined,
    [
      conv,
      employee,
      messages,
      sessionModel,
      asks,
      pending,
      catalog,
      planCapable,
      employees,
      conversations,
      jobsCapable,
      listedJobs,
      jobsTick,
      prsMap,
      thoughts,
      wbCards,
      conversationId,
      rewind,
      rewoundMessages,
      feed.historyTrimmed,
    ],
  );

  return {
    client,
    conv,
    channelId,
    employee,
    detail,
    catalog,
    catalogUnavailable,
    planCapable,
    subagentsCapable,
    jobsCapable,
    channels,
    conversations,
  };
}

export function Thread({
  navigation,
  route,
}: {
  navigation: Nav;
  route: RouteProp<DmRoutes, "Thread">;
}) {
  const { conversationId } = route.params;
  const {
    client,
    conv,
    channelId,
    employee,
    detail,
    catalog,
    catalogUnavailable,
    planCapable,
    subagentsCapable,
    jobsCapable,
  } = useThread(conversationId);
  const welcome = useStore($welcome);
  const link = useStore($link);
  const demo = useStore($demo);
  const paired = useStore($connections)[0];
  const mac = demo ? DEMO_MAC : paired;
  const [prefill, setPrefill] = useState<{ text: string }>();

  /* Composer chip = the thread's pick (pinned conv.model wins), or the
     employee/engine default until one exists (AC-5). */
  const threadPick: ModelPick | undefined = useMemo(() => {
    const model = conv?.model;
    if (model) {
      return {
        model,
        ...(conv?.provider ? { provider: conv.provider } : {}),
        ...(conv?.effort ? { effort: conv.effort } : {}),
        ...(conv?.fast !== undefined ? { fast: conv.fast } : {}),
      };
    }
    const engineHost = welcome?.engineHost;
    return defaultModelPick({
      employeeModel: employee?.model,
      models: catalog.models,
      defaultModel: catalog.defaultModel ?? engineHost?.defaultModel,
      defaultProvider: catalog.defaultProvider ?? engineHost?.defaultProvider,
    });
  }, [conv, employee, catalog, welcome]);
  /* Provider-aware row — the same model id can live under two providers,
     and the picked provider's logo leads the chip. */
  const modelRow = threadPick
    ? findModel(catalog.models, threadPick)
    : undefined;
  const provider = catalog.providers.find((p) => p.id === modelRow?.provider);
  /* #483: same contract as the DM composer — a confirmed-empty catalog
     keeps a disabled "Models unavailable" chip whose press retries. */
  const modelChip = catalog.models.length
    ? threadPick
      ? modelLabel(catalog.models, threadPick)
      : (conv?.model ?? employee?.model ?? "")
    : catalogUnavailable
      ? "Models unavailable"
      : undefined;

  const send = (text: string) => {
    const c = client;
    if (!c || !channelId) return;
    /* A draft still carrying the change prefix answers the open plan ask
       (outcome "change") instead of posting to the thread — web rule. */
    const change = planChangeSend(text, $asks.get(), conversationId);
    if (change) {
      void answerPlanChange(c, change.askId, change.answer);
      return;
    }
    /* #552: the key belongs to the draft, not the tap — the failure path
       refills the composer with the same text, so the resend repeats the
       key and the relay dedupes a stored-but-unanswered first attempt. */
    const dedupeKey = sendKeyFor(`conv:${conversationId}`, text);
    void c
      .request("messages.post", {
        channelId,
        conversationId,
        text,
        dedupeKey,
      })
      .then(() => sendKeyDone(`conv:${conversationId}`, text))
      .catch((e) => {
        Alert.alert("Couldn't send", describeError(e));
        setPrefill({ text });
      });
  };

  /* #182: the Plan card's pills — Approve/Reject answer the plan ask
     through decide(); Change prefills the composer (focused by the
     Composer's own prefill effect) and the send above answers it. */
  const onPlan = (action: PlanAction, planId: string) => {
    if (action === "change") {
      setPrefill({ text: PLAN_CHANGE_PREFIX });
      return;
    }
    const c = client;
    if (!c) return;
    void (async () => {
      const ask = await awaitPlanAsk(conversationId, planId);
      if (ask) await decide(c, ask.id, action === "approve");
    })();
  };

  /* AC-4: the stop button only exists while a turn runs; turns.interrupt
     ends it as "You stopped this turn". */
  const stop = () => {
    const c = client;
    if (!c) return;
    void c
      .request("turns.interrupt", { conversationId })
      .catch((e) => Alert.alert("Couldn't stop", describeError(e)));
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <ThreadHeaderTitle
          title={detail?.title || "Thread"}
          state={detail?.state ?? "working"}
          {...(detail?.failure ? { failureKind: detail.failure.kind } : {})}
          {...(detail?.prs?.length ? { prs: detail.prs } : {})}
          {...(detail?.context ? { context: detail.context } : {})}
          /* #591: offline a "working" header is last-known, not live. */
          stale={
            threadSurface(detail?.state ?? "working", link === "offline").stale
          }
          onPress={() =>
            conv &&
            navigation.navigate("ThreadInfo", { conversationId: conv.id })
          }
        />
      ),
    });
  }, [navigation, detail, conv, link]);

  if (!detail) return <View className="flex-1 bg-background" />;
  return (
    <ThreadScreen
      t={detail}
      model={modelChip}
      modelLogo={provider?.logo}
      modelUnavailable={!catalog.models.length && catalogUnavailable}
      onApprove={(id) => {
        if (client) void decide(client, id, true);
      }}
      onDeny={(id) => {
        if (client) void decide(client, id, false);
      }}
      onSend={send}
      onStop={stop}
      unreachableNote={
        link === "offline" && mac ? `Can't reach ${mac.name}` : undefined
      }
      /* #591: offline + a cached "working" thread — disabled Stop with a
         hint; the header chip degrades via threadSurface's rule. */
      stale={threadSurface(detail.state, link === "offline").stale}
      /* #652: offline, open ask cards render disabled with "Answer once
         <Mac> is back" — any thread state, not only a stale working. */
      asksStale={
        threadSurface(detail.state, link === "offline", mac?.name).asksStale
      }
      answerHint={
        threadSurface(detail.state, link === "offline", mac?.name).answerHint
      }
      {...(catalog.models.length
        ? {
            onPickModel: () =>
              navigation.navigate("ModelPicker", {
                employeeId: detail.employee.id,
                conversationId,
              }),
          }
        : catalogUnavailable && client
          ? {
              onPickModel: () =>
                void refreshModelCatalog(client, $welcome, {
                  refresh: true,
                }),
            }
          : {})}
      {...(subagentsCapable
        ? {
            onOpenSubagent: (a) =>
              navigation.navigate("Subagent", { conversationId, id: a.id }),
            /* #319 AC-4: the turn shows only the "N subagents · Open" line;
               the rows live on the session's Subagents sheet. */
            onOpenSubagents: () =>
              navigation.navigate("Subagents", { conversationId }),
          }
        : {})}
      {...(jobsCapable
        ? {
            onOpenBackground: () =>
              navigation.navigate("Background", { conversationId }),
          }
        : {})}
      {...(planCapable
        ? {
            onPlan,
            onOpenPlan: () => navigation.navigate("Plan", { conversationId }),
          }
        : {})}
      /* #340 AC-2b: the card opens the target's phone view — the Changes
         sheet (optionally one file), the thread's PRs in Session info, or
         the URL itself. */
      onOpenWorkbench={(e) => {
        const t = e.target;
        if (t.url !== undefined) {
          void Linking.openURL(t.url);
          return;
        }
        if (t.pr === true) {
          navigation.navigate("ThreadInfo", { conversationId });
          return;
        }
        /* #543: an engine tab — the only target a folderless session
           accepts; each lands on the phone's matching sheet. */
        if (t.tab !== undefined) {
          navigation.navigate(
            t.tab === "subagents"
              ? "Subagents"
              : t.tab === "background"
                ? "Background"
                : "Plan",
            { conversationId },
          );
          return;
        }
        navigation.navigate("WbDiff", {
          conversationId,
          ...(t.file !== undefined
            ? { path: t.file }
            : t.path !== undefined
              ? { path: t.path }
              : {}),
        });
      }}
      prefill={prefill}
    />
  );
}

/** #182 — the Plan sheet: every version of this thread's plan(s), oldest
    first (files per step, risks, earlier versions). */
export function Plan({
  navigation,
  route,
}: {
  navigation: Nav;
  route: RouteProp<DmRoutes, "Plan">;
}) {
  const { conversationId } = route.params;
  const { detail } = useThread(conversationId);
  const plans =
    detail?.entries.flatMap((e) =>
      e.kind === "agent" && e.plan ? [e.plan] : [],
    ) ?? [];
  if (!plans.length) return <View className="flex-1 bg-background" />;
  return <PlanSheet plans={plans} onDone={() => navigation.goBack()} />;
}

/** #181 — one helper of this thread: brief, steps, report; an employee
    helper's sheet links to its own DM thread (D-#25 — a link, never a copy). */
export function Subagent({
  navigation,
  route,
}: {
  navigation: Nav;
  route: RouteProp<DmRoutes, "Subagent">;
}) {
  const { conversationId, id } = route.params;
  const { detail, conversations, channels } = useThread(conversationId);
  const a = detail?.entries
    .flatMap((e) => (e.kind === "agent" ? (e.subagents ?? []) : []))
    .find((x) => x.id === id);
  if (!a) return <View className="flex-1 bg-background" />;
  return (
    <SubagentSheet
      a={a}
      onDone={() => navigation.goBack()}
      onOpenThread={(threadId) => {
        const conv = conversations.find((c) => c.id === threadId);
        const emp = channels.find((c) => c.id === conv?.channelId)?.employeeId;
        navigation.goBack();
        if (emp) navigation.navigate("Dm", { employeeId: emp });
        navigation.navigate("Thread", { conversationId: threadId });
      }}
    />
  );
}

/** #319 — every helper the thread's turns spun off, Running first then
    Finished (the phone's Subagents tab): a row opens its brief/steps/report
    sheet, an employee helper's row their own thread. Re-reads the feed
    through useThread, so a running helper finishes here live. */
export function Subagents({
  navigation,
  route,
}: {
  navigation: Nav;
  route: RouteProp<DmRoutes, "Subagents">;
}) {
  const { conversationId } = route.params;
  const { detail, conversations, channels } = useThread(conversationId);
  const agents =
    detail?.entries.flatMap((e) =>
      e.kind === "agent" ? (e.subagents ?? []) : [],
    ) ?? [];
  return (
    <SubagentsSheet
      agents={agents}
      onOpen={(a) =>
        navigation.navigate("Subagent", { conversationId, id: a.id })
      }
      onOpenThread={(threadId) => {
        const conv = conversations.find((c) => c.id === threadId);
        const emp = channels.find((c) => c.id === conv?.channelId)?.employeeId;
        navigation.goBack();
        if (emp) navigation.navigate("Dm", { employeeId: emp });
        navigation.navigate("Thread", { conversationId: threadId });
      }}
      onDone={() => navigation.goBack()}
    />
  );
}

/** #181 — the session's background processes: output tails + Stop
    (`jobs.stop` over the relay; the "Stopped by you" label is the sheet's). */
export function Background({
  navigation,
  route,
}: {
  navigation: Nav;
  route: RouteProp<DmRoutes, "Background">;
}) {
  const { conversationId } = route.params;
  const { client, conv, detail } = useThread(conversationId);
  if (!detail) return <View className="flex-1 bg-background" />;
  return (
    <BackgroundSheet
      jobs={detail.jobs ?? []}
      onStop={(jobId) => {
        const c = client;
        const sessionId = conv?.engineRef;
        if (!c || !sessionId) return;
        void c
          .request<{ stopped: boolean }>("jobs.stop", { sessionId, jobId })
          .catch((e) => Alert.alert("Couldn't stop it", describeError(e)));
      }}
      onDone={() => navigation.goBack()}
    />
  );
}

/** #340 AC-2b — a `workbench_open` card's Changes view: the session's
    recorded edits, narrowed to the file the card named when there is one. */
export function WbDiff({
  navigation,
  route,
}: {
  navigation: Nav;
  route: RouteProp<DmRoutes, "WbDiff">;
}) {
  const { conversationId, path } = route.params;
  const { detail } = useThread(conversationId);
  if (!detail) return <View className="flex-1 bg-background" />;
  return (
    <WbDiffSheet
      files={collectDiffs(detail.entries)}
      focus={path}
      onDone={() => navigation.goBack()}
    />
  );
}

/** ⓘ — the Session sheet (AC-6): folder, branch, model, usage, session id. */
export function ThreadInfo({
  navigation,
  route,
}: {
  navigation: Nav;
  route: RouteProp<DmRoutes, "ThreadInfo">;
}) {
  const { conversationId } = route.params;
  const { detail } = useThread(conversationId);
  if (!detail) return <View className="flex-1 bg-background" />;
  return <ThreadInfoSheet t={detail} onDone={() => navigation.goBack()} />;
}
