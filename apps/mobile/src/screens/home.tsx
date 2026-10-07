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
import { decide, negativeOutcome, primaryOutcome } from "../asks";
import { $demo, DEMO_MAC } from "../demo/lifecycle";
import {
  askThreadTarget,
  ensureChannelSubscriptions,
  type HomeWire,
  openAsks,
  toApproval,
  toEmployeeRow,
} from "../home-model";
import { $blockedUpdate, $client, $link, linkUnreachable } from "../link";
import { blockedLine, toHomeChannels } from "../mapping";
import { $connections } from "../paired-macs";
import { nav } from "../routes";
import { ago } from "../time";

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
export function useHomeWire(): {
  client?: AppClient;
  link: ReturnType<typeof $link.get>;
  wire: HomeWire;
} {
  const client = useStore($client);
  const link = useStore($link);
  const employees = useStore(client?.employees ?? $noEmployees);
  const channels = useStore(client?.channels ?? $noChannels);
  const conversations = useStore(client?.conversations ?? $noConversations);
  const summaries = useStore(client?.conversationSummaries ?? $noSummaries);
  const asks = useStore(client?.asks ?? $noAsks);
  return useMemo(
    () => ({
      client,
      link,
      /* #591: "online" for the model = live data. Only `offline` makes the
         rows last-known — a clean reconnect attempt keeps them unmarked so
         a passing hiccup doesn't flicker the whole list. */
      wire: {
        employees,
        channels,
        conversations,
        summaries,
        asks,
        /* #591+#597: live data only while online/reconnecting — offline and
           the version-mismatch `blocked` both leave stale rows, so both
           read last-known. */
        online: !linkUnreachable(link),
      },
    }),
    [client, link, employees, channels, conversations, summaries, asks],
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
  const demo = useStore($demo);
  const paired = useStore($connections)[0];
  /* In demo there is no Keychain pairing row — the world still has a Mac,
     the fake DEMO_MAC (same seam Settings uses; never persisted). */
  const mac = demo ? DEMO_MAC : paired;
  const link = useStore($link);
  const blockedUpdate = useStore($blockedUpdate);
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
      offlineDetail={
        link === "offline"
          ? `Showing last known · ${ago(mac.lastSeenAt)}`
          : undefined
      }
      blockedDetail={
        link === "blocked" ? blockedLine(blockedUpdate) : undefined
      }
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
  /* #595: a plan ask's Review opens the plan where it lives — the
     asking thread, with the DM underneath so Back returns to it. */
  const openPlanThread = (askId: string) => {
    const ask = wire.asks.find((a) => a.id === askId);
    const target = ask && askThreadTarget(ask, wire);
    if (!target) {
      nav.navigate("Tabs", { screen: "Activity" });
      return;
    }
    nav.navigate("Dm", { employeeId: target.employeeId });
    nav.navigate("Thread", {
      conversationId: target.conversationId,
      employeeId: target.employeeId,
    });
  };
  return (
    <NeedsYouAccessory
      approvals={approvals}
      placement={placement}
      /* #601: the one-tap Approve lands the ask's primary option (its
         first non-deny) — not a hard-coded "once". */
      onApprove={(id) => {
        const ask = wire.asks.find((a) => a.id === id);
        if (client && ask) void decide(client, id, primaryOutcome(ask));
      }}
      onReview={openPlanThread}
      onOpen={() => nav.navigate("Tabs", { screen: "Activity" })}
    />
  );
}

export function Activity() {
  const demo = useStore($demo);
  const paired = useStore($connections)[0];
  const mac = demo ? DEMO_MAC : paired;
  const { client, link, wire } = useHomeWire();
  const nowMs = useNowMs();
  const approvals = useMemo(
    () => openAsks(wire.asks).map((a) => toApproval(a, wire, nowMs)),
    [wire, nowMs],
  );
  /* #594/#595: Open and a plan's Review share one landing — the asking
     thread pushed over its DM, so Back returns to the DM. */
  const openAskThread = (askId: string) => {
    const ask = wire.asks.find((a) => a.id === askId);
    const target = ask && askThreadTarget(ask, wire);
    if (!target) return;
    nav.navigate("Dm", { employeeId: target.employeeId });
    nav.navigate("Thread", {
      conversationId: target.conversationId,
      employeeId: target.employeeId,
    });
  };
  return (
    <ApprovalsSheet
      approvals={approvals}
      /* #591: while the Mac is unreachable the list is last-known — the
         sheet marks it and the empty state never reads "All clear". */
      unreachable={
        linkUnreachable(link) && mac
          ? {
              mac: mac.name,
              asOf: ago(mac.lastSeenAt),
              /* #597: blocked is an update prompt, not a reach issue. */
              line: link === "blocked" ? "Update needed" : undefined,
            }
          : undefined
      }
      /* #601: approval rows offer the ask's own options — the tapped one
         is the outcome; the plain Approve/Deny path stays for kinds the
         sheet doesn't grant through (question Skip → cancel, plan →
         reject). */
      onApprove={(id) => {
        const ask = wire.asks.find((a) => a.id === id);
        if (client && ask) void decide(client, id, primaryOutcome(ask));
      }}
      onDeny={(id) => {
        const ask = wire.asks.find((a) => a.id === id);
        if (client && ask) void decide(client, id, negativeOutcome(ask));
      }}
      onGrant={(id, option) => {
        if (client) void decide(client, id, option);
      }}
      onOpen={openAskThread}
      onReview={openAskThread}
    />
  );
}
