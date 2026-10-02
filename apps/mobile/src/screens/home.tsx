import type { AppClient } from "@lilos/client-runtime";
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
  NeedsYouAccessory,
} from "@lilos/ui-native";
import { useStore } from "@nanostores/react";
import { atom } from "nanostores";
import { useEffect, useMemo, useState } from "react";
import { Alert } from "react-native";
import { decide } from "../asks";
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
import { nav } from "../routes";

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
export function useHomeWire(): { client?: AppClient; wire: HomeWire } {
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
  client: AppClient | undefined,
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
  const { client, wire } = useHomeWire();
  const nowMs = useNowMs();
  const approvals = useMemo(
    () => openAsks(wire.asks).map((a) => toApproval(a, wire, nowMs)),
    [wire, nowMs],
  );
  return (
    <NeedsYouAccessory
      approvals={approvals}
      placement={placement}
      onApprove={(id) => {
        if (client) void decide(client, id, true);
      }}
      onOpen={() => nav.navigate("Tabs", { screen: "Activity" })}
    />
  );
}

export function Activity() {
  const { client, wire } = useHomeWire();
  const nowMs = useNowMs();
  const approvals = useMemo(
    () => openAsks(wire.asks).map((a) => toApproval(a, wire, nowMs)),
    [wire, nowMs],
  );
  return (
    <ApprovalsSheet
      approvals={approvals}
      onApprove={(id) => {
        if (client) void decide(client, id, true);
      }}
      onDeny={(id) => {
        if (client) void decide(client, id, false);
      }}
      onOpen={(askId) => {
        const ask = wire.asks.find((a) => a.id === askId);
        const channel = wire.channels.find((c) => c.id === ask?.channelId);
        if (channel?.employeeId)
          nav.navigate("Dm", { employeeId: channel.employeeId });
      }}
    />
  );
}
