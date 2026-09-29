import type {
  AppChannel,
  AppMessage,
  Conversation,
  ConversationSummary,
  Employee,
} from "@lilos/contracts/app";
import {
  DmHeaderTitle,
  EmployeeDmScreen,
  FolderPickerSheet,
  type ModelPick,
  ModelPickerSheet,
  modelLabel,
  type OrbState,
  pickLabel,
  type WorkspacePick,
} from "@lilos/ui-native";
import { useStore } from "@nanostores/react";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { atom } from "nanostores";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import {
  defaultModelPick,
  defaultWorkspacePick,
  headerStatus,
  openConversationParams,
  toFolderOptions,
  toSessionTurns,
} from "../dm-model";
import {
  $asks,
  $catalog,
  $folderDetails,
  $folders,
  $modelPicks,
  $pendingOpens,
  $wsPicks,
  clearPending,
  markPending,
  watchDm,
} from "../dm-store";
import { $client, $welcome } from "../link";
import { describeError, toneOf } from "../mapping";
import type { DmRoutes } from "../routes";

/* The employee's DM (#156): the real relay's conversation.summaries grouped
   Needs you / Working / Done, live over the channel subscription + ask
   events, and the glass composer opens a new thread (conversations.open)
   with the picked folder + model. Mapping rules live in ../dm-model.ts. */

type Nav = NativeStackNavigationProp<DmRoutes>;

const $noEmployees = atom<Employee[]>([]);
const $noChannels = atom<AppChannel[]>([]);
const $noSummaries = atom<ConversationSummary[]>([]);
const $noConversations = atom<Conversation[]>([]);
const $linkIdle =
  atom<import("@lilos/client-runtime").RelayConnectionState>("idle");

/** Re-render so "Nm"/"Nh" row times stay honest. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function Dm({
  navigation,
  route,
}: {
  navigation: Nav;
  route: RouteProp<DmRoutes, "Dm">;
}) {
  const { employeeId } = route.params;
  const client = useStore($client);
  const welcome = useStore($welcome);
  const employees = useStore(client?.employees ?? $noEmployees);
  const channels = useStore(client?.channels ?? $noChannels);
  const summaries = useStore(client?.conversationSummaries ?? $noSummaries);
  const conversations = useStore(client?.conversations ?? $noConversations);
  const clientState = useStore(client?.state ?? $linkIdle);
  const asks = useStore($asks);
  const recents = useStore($folders);
  const details = useStore($folderDetails);
  const catalog = useStore($catalog);
  const wsPicks = useStore($wsPicks);
  const modelPicks = useStore($modelPicks);
  const pending = useStore($pendingOpens);
  const now = useNow();

  const employee = employees.find((e) => e.id === employeeId);
  const channel = channels.find(
    (c) => c.kind === "dm" && c.employeeId === employeeId,
  );
  const folderOptions = useMemo(
    () => toFolderOptions(recents, details),
    [recents, details],
  );
  const [prefill, setPrefill] = useState<{ text: string } | undefined>();
  const opening = useRef(false);

  /* Seed asks/recents/models once per client; resubscribe the DM channel. */
  useEffect(() => {
    if (!client) return;
    watchDm(client);
  }, [client]);
  useEffect(() => {
    if (client && channel) void client.channelMessages(channel.id);
  }, [client, channel]);

  /* First visit for an employee with no DM yet: open one (idempotent).
     Retries whenever the link comes back ready. */
  const [dmError, setDmError] = useState<string | undefined>();
  useEffect(() => {
    if (
      !client ||
      channel ||
      clientState !== "ready" ||
      opening.current ||
      !employee
    )
      return;
    opening.current = true;
    client
      .request<{ channel: AppChannel }>("channels.openDm", { employeeId })
      .catch((e: unknown) => setDmError(describeError(e)))
      .finally(() => {
        opening.current = false;
      });
  }, [client, channel, clientState, employee, employeeId]);

  useEffect(() => {
    if (!dmError) return;
    Alert.alert("Couldn't open this DM", dmError, [
      { text: "OK", onPress: () => setDmError(undefined) },
    ]);
  }, [dmError]);

  /* Pending markers retire once the conversation is engine-bound — while it
     stays idle+unbound it IS the "submitted" window (web stillPending). */
  useEffect(() => {
    for (const id of pending.keys()) {
      const c = conversations.find((x) => x.id === id);
      if (c && (c.engineRef !== null || c.state !== "idle")) clearPending(id);
    }
  }, [conversations, pending]);

  const openAsks = asks.filter(
    (a) => a.state === "open" && a.channelId === channel?.id,
  );
  const turns = channel
    ? toSessionTurns(summaries, {
        channelId: channel.id,
        employee: employee
          ? {
              id: employee.id,
              name: employee.name,
              tone: toneOf(employee.id),
            }
          : { id: employeeId, name: employeeId, tone: "stone" },
        openAsks,
        pending,
        now,
      })
    : [];
  const status = headerStatus(turns);
  const orbState: OrbState = turns.some((t) => t.state === "needs-you")
    ? "needs-you"
    : turns.some((t) => t.state === "working")
      ? "working"
      : "idle";

  useLayoutEffect(() => {
    if (!employee) return;
    navigation.setOptions({
      headerTitle: () => (
        <DmHeaderTitle
          name={employee.name}
          tone={toneOf(employee.id)}
          state={orbState}
          status={status}
          onPress={() =>
            Alert.alert(
              employee.name,
              [
                employee.role,
                employee.model ? `Model: ${employee.model}` : "",
                employee.now,
              ]
                .filter(Boolean)
                .join("\n"),
            )
          }
        />
      ),
    });
  }, [navigation, employee, orbState, status]);

  /* The composer's starting picks — applied once, never overwriting a pick
     the user already made (web #113 AC-6). */
  useEffect(() => {
    if (!employee || wsPicks[employeeId] !== undefined) return;
    const lastCwd = conversations
      .filter((c) => c.channelId === channel?.id && c.cwd)
      .sort((a, b) => b.createdAt - a.createdAt)[0]?.cwd;
    if (lastCwd && !folderOptions.length) return; // wait for recents
    $wsPicks.set({
      ...$wsPicks.get(),
      [employeeId]: defaultWorkspacePick(folderOptions, lastCwd),
    });
  }, [
    employee,
    employeeId,
    wsPicks,
    conversations,
    channel?.id,
    folderOptions,
  ]);

  useEffect(() => {
    if (!employee || modelPicks[employeeId] !== undefined) return;
    const engineHost = welcome?.engineHost;
    const pick = defaultModelPick({
      employeeModel: employee.model,
      models: catalog.models,
      defaultModel: catalog.defaultModel ?? engineHost?.defaultModel,
      defaultProvider: catalog.defaultProvider ?? engineHost?.defaultProvider,
    });
    if (pick) $modelPicks.set({ ...$modelPicks.get(), [employeeId]: pick });
  }, [employee, employeeId, modelPicks, catalog, welcome]);

  if (!employee) return null;

  const wsPick = wsPicks[employeeId] ?? {
    folder: null,
    base: "",
    mode: "direct" as const,
  };
  const modelPick = modelPicks[employeeId];
  const modelRow = modelPick
    ? catalog.models.find((m) => m.id === modelPick.model)
    : undefined;
  const provider = catalog.providers.find((p) => p.id === modelRow?.provider);
  const modelChip = modelPick
    ? modelLabel(catalog.models, modelPick)
    : employee.model || catalog.defaultModel || "Default";

  const send = (text: string) => {
    const c = client;
    if (!c) return;
    void (async () => {
      try {
        const ch =
          channel ??
          (
            await c.request<{ channel: AppChannel }>("channels.openDm", {
              employeeId,
            })
          ).channel;
        const res = await c.request<{
          conversation: Conversation;
          rootMessage: AppMessage;
        }>("conversations.open", {
          channelId: ch.id,
          text,
          ...openConversationParams({
            workspace: wsPick,
            folders: folderOptions,
            model: modelPick,
            models: catalog.models,
            text,
          }),
        });
        markPending(res.conversation, res.rootMessage);
        navigation.navigate("Thread", {
          conversationId: res.conversation.id,
        });
      } catch (e) {
        Alert.alert("Couldn't send", describeError(e));
        setPrefill({ text });
      }
    })();
  };

  return (
    <EmployeeDmScreen
      name={employee.name}
      tone={toneOf(employee.id)}
      turns={turns}
      folder={pickLabel(folderOptions, wsPick)}
      model={modelChip}
      modelLogo={provider?.logo}
      onOpenSession={(id) =>
        navigation.navigate("Thread", { conversationId: id })
      }
      onSend={send}
      onPickFolder={() => navigation.navigate("FolderPicker", { employeeId })}
      onPickModel={() => navigation.navigate("ModelPicker", { employeeId })}
      prefill={prefill}
    />
  );
}

export function FolderPicker({
  navigation,
  route,
}: {
  navigation: Nav;
  route: RouteProp<DmRoutes, "FolderPicker">;
}) {
  const { employeeId } = route.params;
  const recents = useStore($folders);
  const details = useStore($folderDetails);
  const folders = useMemo(
    () => toFolderOptions(recents, details),
    [recents, details],
  );
  const picks = useStore($wsPicks);
  const pick = picks[employeeId] ?? {
    folder: null,
    base: "",
    mode: "direct" as const,
  };
  return (
    <FolderPickerSheet
      folders={folders}
      pick={pick}
      onBrowse={() => navigation.navigate("BrowseMac", { employeeId })}
      onPick={(p: WorkspacePick) => {
        void Haptics.selectionAsync();
        $wsPicks.set({ ...$wsPicks.get(), [employeeId]: p });
      }}
      onDone={() => navigation.goBack()}
    />
  );
}

export function ModelPicker({
  navigation,
  route,
}: {
  navigation: Nav;
  route: RouteProp<DmRoutes, "ModelPicker">;
}) {
  const { employeeId, conversationId } = route.params;
  const client = useStore($client);
  const employees = useStore(client?.employees ?? $noEmployees);
  const conversations = useStore(client?.conversations ?? $noConversations);
  const employee = employees.find((e) => e.id === employeeId);
  /* Thread scope (#157 AC-5): a conversationId pins this conversation via
     conversations.setModel; the employee-scope pick stays the DM default. */
  const conv = conversations.find((c) => c.id === conversationId);
  const catalog = useStore($catalog);
  const welcome = useStore($welcome);
  const picks = useStore($modelPicks);
  const [picked, setPicked] = useState<ModelPick>();
  const value = (conversationId
    ? (picked ??
      (conv?.model
        ? {
            model: conv.model,
            ...(conv.effort ? { effort: conv.effort } : {}),
            ...(conv.fast !== undefined ? { fast: conv.fast } : {}),
          }
        : undefined))
    : picks[employeeId]) ??
    defaultModelPick({
      employeeModel: employee?.model,
      models: catalog.models,
      defaultModel: catalog.defaultModel ?? welcome?.engineHost?.defaultModel,
      defaultProvider:
        catalog.defaultProvider ?? welcome?.engineHost?.defaultProvider,
    }) ?? { model: "" };
  return (
    <ModelPickerSheet
      models={catalog.models}
      providers={catalog.providers}
      value={value}
      onPick={(p: ModelPick) => {
        void Haptics.selectionAsync();
        /* Thread scope asked for but the conversation isn't in the client
           yet (pending-open window): a pick here must not silently land as
           the employee's DM default. */
        if (conversationId !== undefined) {
          if (conv && client) {
            setPicked(p);
            const row = catalog.models.find((m) => m.id === p.model);
            void client
              .request("conversations.setModel", {
                conversationId: conv.id,
                model: p.model,
                ...(row?.provider ? { provider: row.provider } : {}),
                ...(p.effort ? { effort: p.effort } : {}),
                ...(p.fast !== undefined ? { fast: p.fast } : {}),
              })
              .catch((e) => Alert.alert("Couldn't switch", describeError(e)));
          } else {
            Alert.alert(
              "Couldn't switch",
              "This thread isn't loaded yet — try again in a moment.",
            );
          }
          return;
        }
        $modelPicks.set({ ...$modelPicks.get(), [employeeId]: p });
      }}
      onDone={() => navigation.goBack()}
    />
  );
}
