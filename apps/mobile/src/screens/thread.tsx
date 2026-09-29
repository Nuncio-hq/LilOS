import {
  type ChannelMessagesState,
  type RelaySessionFeedState,
  reduceSessionEvents,
} from "@lilos/client-runtime";
import type {
  AppChannel,
  AppMessage,
  Conversation,
  Employee,
} from "@lilos/contracts/app";
import type { ModelPick } from "@lilos/ui-native";
import {
  modelLabel,
  ThreadHeaderTitle,
  ThreadInfoSheet,
  ThreadScreen,
} from "@lilos/ui-native";
import { useStore } from "@nanostores/react";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { atom } from "nanostores";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Alert, View } from "react-native";
import { defaultModelPick } from "../dm-model";
import { $asks, $catalog, $pendingOpens, watchDm } from "../dm-store";
import { $client, $welcome } from "../link";
import { describeError } from "../mapping";
import type { DmRoutes } from "../routes";
import { toThreadDetail } from "../thread-model";

/* #157 — the live thread: messages.list + channel.subscribe resume (AC-1),
   engine turns projected live through sessionFeed -> reduceSessionEvents ->
   ThreadEntry[] (AC-2), reply/steer via messages.post (AC-3), turns.interrupt
   stop (AC-4), per-thread model pick (AC-5), the ⓘ session sheet (AC-6).
   Approvals render read-only — answering is sibling slice #158. */

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

/** Everything a thread screen needs from the wire, packed for the view. */
function useThread(conversationId: string) {
  const client = useStore($client);
  const conversations = useStore(client?.conversations ?? $noConversations);
  const employees = useStore(client?.employees ?? $noEmployees);
  const channels = useStore(client?.channels ?? $noChannels);
  const asks = useStore($asks);
  const pending = useStore($pendingOpens);
  const catalog = useStore($catalog);

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
  const sessionModel = useMemo(
    () =>
      feed.sessionId
        ? reduceSessionEvents(feed.sessionId, feed.events, feed.snapshot)
        : undefined,
    [feed.sessionId, feed.events, feed.snapshot],
  );

  const employee = conv
    ? employees.find(
        (e) =>
          e.id === channels.find((c) => c.id === conv.channelId)?.employeeId,
      )
    : undefined;

  /* AC-1: full history once via messages.list (the channel snapshot is a
     window); live frames keep appending on the subscription. */
  const [history, setHistory] = useState<AppMessage[]>([]);
  useEffect(() => {
    if (!client || !channelId) return;
    watchDm(client);
    let alive = true;
    const pull = () => {
      void client
        .request<{ messages: AppMessage[] }>("messages.list", {
          channelId,
          conversationId,
        })
        .then((res) => {
          if (alive) setHistory(res.messages);
        })
        .catch(() => {});
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

  const messages = useMemo(() => {
    const byId = new Map<string, AppMessage>();
    for (const m of history) byId.set(m.id, m);
    for (const m of chanState.messages) {
      if (m.conversationId === conversationId) byId.set(m.id, m);
    }
    if (pendingEntry) byId.set(pendingEntry.root.id, pendingEntry.root);
    return [...byId.values()].sort((a, b) => a.seq - b.seq);
  }, [history, chanState.messages, conversationId, pendingEntry]);

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
          })
        : undefined,
    [conv, employee, messages, sessionModel, asks, pending, catalog],
  );

  return { client, conv, channelId, employee, detail, catalog };
}

export function Thread({
  navigation,
  route,
}: {
  navigation: Nav;
  route: RouteProp<DmRoutes, "Thread">;
}) {
  const { conversationId } = route.params;
  const { client, conv, channelId, employee, detail, catalog } =
    useThread(conversationId);
  const welcome = useStore($welcome);
  const [prefill, setPrefill] = useState<{ text: string }>();

  /* Composer chip = the thread's pick (pinned conv.model wins), or the
     employee/engine default until one exists (AC-5). */
  const threadPick: ModelPick | undefined = useMemo(() => {
    const model = conv?.model;
    if (model) {
      return {
        model,
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
  const modelRow = threadPick
    ? catalog.models.find((m) => m.id === threadPick.model)
    : undefined;
  const provider = catalog.providers.find((p) => p.id === modelRow?.provider);
  const modelChip = threadPick
    ? modelLabel(catalog.models, threadPick)
    : (conv?.model ?? employee?.model ?? "");

  const send = (text: string) => {
    const c = client;
    if (!c || !channelId) return;
    const dedupeKey = `u-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    void c
      .request("messages.post", {
        channelId,
        conversationId,
        text,
        dedupeKey,
      })
      .catch((e) => {
        Alert.alert("Couldn't send", describeError(e));
        setPrefill({ text });
      });
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
          onPress={() =>
            conv &&
            navigation.navigate("ThreadInfo", { conversationId: conv.id })
          }
        />
      ),
    });
  }, [navigation, detail, conv]);

  if (!detail) return <View className="flex-1 bg-background" />;
  return (
    <ThreadScreen
      t={detail}
      model={modelChip}
      modelLogo={provider?.logo}
      onApprove={() =>
        Alert.alert(
          "Ask",
          "Answering approvals from the phone lands in the next update — approve or deny on your Mac for now.",
        )
      }
      onDeny={() =>
        Alert.alert(
          "Ask",
          "Answering approvals from the phone lands in the next update — approve or deny on your Mac for now.",
        )
      }
      onSend={send}
      onStop={stop}
      onPickModel={() =>
        navigation.navigate("ModelPicker", {
          employeeId: detail.employee.id,
          conversationId,
        })
      }
      prefill={prefill}
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
