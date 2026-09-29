import type { ChannelMessagesState } from "@lilos/client-runtime";
import type {
  AppChannel,
  AppMessage,
  Conversation,
  Employee,
} from "@lilos/contracts/app";
import { AppText, Orb, ThreadHeaderTitle } from "@lilos/ui-native";
import { useStore } from "@nanostores/react";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { atom } from "nanostores";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { conversationState, folderLeaf, timeLabel } from "../dm-model";
import { $asks, $pendingOpens, watchDm } from "../dm-store";
import { $client } from "../link";
import { toneOf } from "../mapping";
import type { DmRoutes } from "../routes";

/* A thread, read-only for now (#156): its messages.list plainly rendered —
   user bubbles right, the employee's words left, system lines muted. Live
   because the channel subscription keeps streaming into channelMessages.
   The full live thread (streaming turns, reply composer, approvals) is the
   sibling slice #157 — until then this shows what already crossed the wire. */

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

export function Thread({
  navigation,
  route,
}: {
  navigation: Nav;
  route: RouteProp<DmRoutes, "Thread">;
}) {
  const { conversationId } = route.params;
  const client = useStore($client);
  const conversations = useStore(client?.conversations ?? $noConversations);
  const employees = useStore(client?.employees ?? $noEmployees);
  const channels = useStore(client?.channels ?? $noChannels);
  const asks = useStore($asks);
  const pending = useStore($pendingOpens);
  const insets = useSafeAreaInsets();

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

  const employee = conv
    ? employees.find(
        (e) =>
          e.id === channels.find((c) => c.id === conv.channelId)?.employeeId,
      )
    : undefined;

  /* Full thread history once per conversation (the channel snapshot only
     carries a window); live frames keep appending through the subscription. */
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

  const state = conv
    ? conversationState(conv, {
        openAsks: asks,
        pending: new Set(pending.keys()),
      })
    : "working";

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <ThreadHeaderTitle
          title={conv?.title || pendingEntry?.root.text || "Thread"}
          state={state}
          onPress={() => {
            if (!conv) return;
            Alert.alert(
              conv.title || "Thread",
              [
                state,
                conv.cwd ? `Folder: ${folderLeaf(conv.cwd)}` : "",
                conv.model ? `Model: ${conv.model}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            );
          }}
        />
      ),
    });
  }, [navigation, conv, state, pendingEntry]);

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "flex-end",
          paddingTop: 12,
          paddingBottom: Math.max(insets.bottom, 16),
          paddingHorizontal: 16,
          gap: 20,
        }}
      >
        {!messages.length && (
          <AppText tone="muted" className="text-center text-[15px]">
            Nothing here yet.
          </AppText>
        )}
        {messages.map((m) =>
          m.authorKind === "user" ? (
            <UserBubble key={m.id} text={m.text} time={m.createdAt} />
          ) : (
            <View key={m.id} className="flex-row gap-2.5">
              <View className="pt-0.5">
                <Orb
                  tone={employee ? toneOf(employee.id) : "stone"}
                  size={24}
                />
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-[15px] leading-5 text-muted-foreground">
                  {m.text}
                </Text>
                <AppText tone="muted" className="mt-0.5 text-[12px]">
                  {timeLabel(m.createdAt, Date.now())}
                  {m.authorKind === "system" ? " · system" : ""}
                </AppText>
              </View>
            </View>
          ),
        )}
      </ScrollView>
    </View>
  );
}

function UserBubble({ text, time }: { text: string; time: number }) {
  return (
    <View className="items-end">
      <View className="max-w-[85%] rounded-[18px] bg-primary px-3.5 py-2">
        <Text className="text-[16px] leading-[21px] text-primary-foreground">
          {text}
        </Text>
      </View>
      <AppText tone="muted" className="mt-1 text-[12px]">
        {timeLabel(time, Date.now())}
      </AppText>
    </View>
  );
}
