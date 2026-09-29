import type { RelayClient } from "@lilos/client-runtime";
import type {
  AppChannel,
  Ask,
  Conversation,
  ConversationSummary,
  Employee,
} from "@lilos/contracts/app";
import {
  ApprovalsSheet,
  EmployeesHomeScreen,
  LargeTitle,
  NeedsYouAccessory,
  Screen,
  StateBlock,
} from "@lilos/ui-native";
import { useStore } from "@nanostores/react";
import { atom } from "nanostores";
import { useEffect, useMemo, useState } from "react";
import { Alert } from "react-native";
import {
  ensureChannelSubscriptions,
  type HomeWire,
  openAsks,
  toApproval,
  toEmployeeRow,
} from "../home-model";
import { $client, $link } from "../link";
import { toHomeChannels } from "../mapping";
import { $connections } from "../paired-macs";
import { nav, type Props } from "../routes";

/* The app tabs after pairing (#155): Home (live employees + channels),
   Activity (every open ask), the Needs-you bottom accessory, and the DM
   route. Wire data reaches the screens through home-model only. */

const $noEmployees = atom<Employee[]>([]);
const $noChannels = atom<AppChannel[]>([]);
const $noConversations = atom<Conversation[]>([]);
const $noSummaries = atom<ConversationSummary[]>([]);
const $noAsks = atom<Ask[]>([]);

function soon(what: string) {
  Alert.alert(`${what} come next`, "This release covers the Home list.");
}

/** Every read model Home derives from, in one bundle for the model. */
export function useHomeWire(): { client?: RelayClient; wire: HomeWire } {
  const client = useStore($client);
  const employees = useStore(client?.employees ?? $noEmployees);
  const channels = useStore(client?.channels ?? $noChannels);
  const conversations = useStore(client?.conversations ?? $noConversations);
  const summaries = useStore(client?.conversationSummaries ?? $noSummaries);
  const asks = useStore(client?.asks ?? $noAsks);
  return useMemo(
    () => ({
      client,
      wire: { employees, channels, conversations, summaries, asks },
    }),
    [client, employees, channels, conversations, summaries, asks],
  );
}

/** Ages re-render every 30s so "4m" keeps ticking without a pull-to-refresh. */
const AGE_TICK_MS = 30_000;
function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(tick);
  }, []);
  return now;
}

/* ask/turn events ride `channel.subscribe` only — subscribe every DM channel
   once (idempotent; intent survives reconnects through resubscribeAll). */
function useLiveChannels(
  client: RelayClient | undefined,
  channels: AppChannel[],
): void {
  useEffect(() => {
    if (client) ensureChannelSubscriptions(client, channels);
  }, [client, channels]);
}

export function Home() {
  const mac = useStore($connections)[0];
  const link = useStore($link);
  const { client, wire } = useHomeWire();
  useLiveChannels(client, wire.channels);
  const nowMs = useNowMs();
  const { company, projects } = toHomeChannels(wire.channels);
  if (!mac) return null;
  return (
    <EmployeesHomeScreen
      workspace="LilOS"
      macName={mac.name}
      link={link}
      employees={wire.employees.map((e) => toEmployeeRow(e, wire, nowMs))}
      company={company}
      projects={projects}
      onOpenMac={() => nav.navigate("Mac")}
      onOpenEmployee={(employeeId) => nav.navigate("Dm", { employeeId })}
      onOpenChannel={() => soon("Channels")}
    />
  );
}

/* Needs you accessory for the tab bar's bottomAccessory slot: oldest open
   ask + "+N more"; renders nothing when the list is empty (the navigator
   drops the slot entirely — Tabs only mounts it while asks exist). */
export function NeedsYouSlot({
  placement,
}: {
  placement: "regular" | "inline";
}) {
  const { wire } = useHomeWire();
  const nowMs = useNowMs();
  const approvals = useMemo(
    () => openAsks(wire.asks).map((a) => toApproval(a, wire, nowMs)),
    [wire, nowMs],
  );
  return (
    <NeedsYouAccessory
      approvals={approvals}
      placement={placement}
      onOpen={() => nav.navigate("Tabs", { screen: "Activity" })}
    />
  );
}

export function Activity() {
  const { wire } = useHomeWire();
  const nowMs = useNowMs();
  const approvals = useMemo(
    () => openAsks(wire.asks).map((a) => toApproval(a, wire, nowMs)),
    [wire, nowMs],
  );
  return (
    <ApprovalsSheet
      approvals={approvals}
      onOpen={(askId) => {
        const ask = wire.asks.find((a) => a.id === askId);
        const channel = wire.channels.find((c) => c.id === ask?.channelId);
        if (channel?.employeeId)
          nav.navigate("Dm", { employeeId: channel.employeeId });
      }}
    />
  );
}

/* A DM named for its employee. The thread list inside is #156's slice —
   until its screen lands this shows who you opened rather than dead-ending
   the tap (still a real route with real params, just a thin body). */
export function Dm({ route }: Props<"Dm">) {
  const { wire } = useHomeWire();
  const employee = wire.employees.find((e) => e.id === route.params.employeeId);
  return (
    <Screen topInset={false}>
      <LargeTitle title={employee?.name ?? "Direct message"} />
      <StateBlock
        icon="bubble.left.and.bubble.right"
        title="Direct messages"
        body={`Threads with ${employee?.name ?? "this employee"} land in the next release.`}
      />
    </Screen>
  );
}
