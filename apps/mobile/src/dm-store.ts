import type { AppClient } from "@lilos/client-runtime";
import type {
  AppMessage,
  Ask,
  Conversation,
  FoldersDetailResult,
  RecentFolder,
} from "@lilos/contracts/app";
import type {
  ModelPick,
  ModelProviderRow,
  ModelRow,
  ModelVisibility,
  WbCardTarget,
  WorkspacePick,
} from "@lilos/ui-native";
import { atom } from "nanostores";
import { toModelCatalog } from "./dm-model";
import { watchPrs } from "./prs";

/* Shared DM state (#156): open asks, folder recents, the engine model
   catalog, the composer's per-employee picks, and opens the phone itself
   sent (the "submitted" window before a summary row exists). Each watcher
   runs once per RelayClient — a re-paired Mac gets a fresh one. */

export const $asks = atom<Ask[]>([]);
export const $folders = atom<RecentFolder[]>([]);
/** Branch/workstream probe per recents path; absent = still probing (#156). */
export const $folderDetails = atom<Record<string, FoldersDetailResult>>({});
export const $catalog = atom<{
  models: ModelRow[];
  providers: ModelProviderRow[];
  defaultModel?: string;
  defaultProvider?: string;
}>({ models: [], providers: [] });
/** The shared "Edit models" hide list (#160 AC-1) — relay-persisted, the
    same KV the Mac's picker reads (`modelVisibility`). */
export const $modelVisibility = atom<ModelVisibility>({
  providers: [],
  models: [],
});
export const $wsPicks = atom<Record<string, WorkspacePick>>({});
export const $modelPicks = atom<Record<string, ModelPick>>({});
export const $pendingOpens = atom<
  Map<string, { conversation: Conversation; root: AppMessage }>
>(new Map());
/** `workbench.opened` events per conversation (#340 AC-2b) — the tappable
    "look at this" cards appended to the thread, newest last. */
export const $wbCards = atom<
  Record<string, { at: number; target: WbCardTarget }[]>
>({});

const watched = new WeakSet<AppClient>();

/** Seed asks + recents + the model catalog, then track ask events live. */
export function watchDm(client: AppClient): void {
  if (watched.has(client)) return;
  watched.add(client);
  /* #159: the turn-end PR refresh watcher lives beside the ask watcher —
     same once-per-client registration. */
  watchPrs(client);

  const seed = () => {
    void client
      .request<{ asks: Ask[] }>("asks.list", {})
      .then((res) => $asks.set(res.asks))
      .catch(() => {});
    void client
      .request<{ folders: RecentFolder[] }>("folders.list", {})
      .then((res) => {
        $folders.set(res.folders);
        void refreshFolderDetails(client);
      })
      .catch(() => {});
    void client
      .listModels({ refresh: false })
      .then((res) => {
        const { models, providers } = toModelCatalog(res);
        $catalog.set({
          models,
          providers,
          defaultModel: res.default,
          defaultProvider: res.defaultProvider,
        });
      })
      .catch(() => {});
    void client
      .request<{ value: unknown }>("settings.get", { key: "modelVisibility" })
      .then((res) => {
        if (res.value) $modelVisibility.set(res.value as ModelVisibility);
      })
      .catch(() => {});
  };
  if (client.state.get() === "ready") seed();
  client.state.listen((s) => {
    if (s === "ready") seed();
  });

  client.onEvent((method, params) => {
    /* #340 AC-2b: the agent's `workbench_open` — a card per call, appended
       in order like a message; the phone can't open a desktop panel. */
    if (method === "workbench.opened") {
      const { conversationId, target } = params as {
        conversationId?: string;
        target?: WbCardTarget;
      };
      if (!conversationId || !target) return;
      const cur = $wbCards.get();
      $wbCards.set({
        ...cur,
        [conversationId]: [
          ...(cur[conversationId] ?? []),
          { at: Date.now(), target },
        ],
      });
      return;
    }
    /* A hide-list write by any peer (the Mac's Edit models) lands on every
       surface at once (#92 AC-7). */
    if (method === "settings.changed") {
      const { key, value } = params as { key?: string; value?: unknown };
      if (key === "modelVisibility") {
        $modelVisibility.set(
          (value as ModelVisibility) ?? { providers: [], models: [] },
        );
      }
      return;
    }
    if (method !== "ask.opened" && method !== "ask.resolved") return;
    const ask = (params as { ask?: Ask }).ask;
    if (!ask) return;
    const list = $asks.get();
    $asks.set(
      list.some((a) => a.id === ask.id)
        ? list.map((a) => (a.id === ask.id ? ask : a))
        : [...list, ask],
    );
  });
}

/**
 * `folders.detail` for every recents entry (#156): the picker's
 * branches/workstreams. A refused or failed probe resolves to an empty
 * result — the sheet then offers direct/just-chat for that folder.
 */
async function refreshFolderDetails(client: AppClient): Promise<void> {
  const empty = (path: string): FoldersDetailResult => ({
    path,
    missing: false,
    isRepo: false,
    branches: [],
    workstreams: [],
  });
  await Promise.all(
    $folders.get().map(async (f) => {
      const res = await client
        .request<FoldersDetailResult>("folders.detail", { path: f.path })
        .catch(() => empty(f.path));
      $folderDetails.set({ ...$folderDetails.get(), [f.path]: res });
    }),
  );
}

/**
 * `folders.add` then resync recents + their git probes (#238 AC-3): the
 * phone's "Use" writes the picked folder into the shared recents (web sees
 * it too), and the probes land before the composer's workspace rows need
 * them.
 */
export async function addRecentFolder(
  client: AppClient,
  path: string,
): Promise<void> {
  await client.request("folders.add", { path });
  const res = await client.request<{ folders: RecentFolder[] }>(
    "folders.list",
    {},
  );
  $folders.set(res.folders);
  await refreshFolderDetails(client);
}

/** Mark a just-opened conversation until its summary/engine bind lands. */
export function markPending(
  conversation: Conversation,
  root: AppMessage,
): void {
  const next = new Map($pendingOpens.get());
  next.set(conversation.id, { conversation, root });
  $pendingOpens.set(next);
}

/** Drop the pending marker once the engine bound (or the row is real). */
export function clearPending(conversationId: string): void {
  const cur = $pendingOpens.get();
  if (!cur.has(conversationId)) return;
  const next = new Map(cur);
  next.delete(conversationId);
  $pendingOpens.set(next);
}

/** Demo exit / re-pair: drop everything the last client fed these atoms
    (#168 AC-4 — nothing demo-owned survives). */
export function resetDmStore(): void {
  $asks.set([]);
  $folders.set([]);
  $folderDetails.set({});
  $catalog.set({ models: [], providers: [] });
  $modelVisibility.set({ providers: [], models: [] });
  $wsPicks.set({});
  $modelPicks.set({});
  $pendingOpens.set(new Map());
  $wbCards.set({});
}
