import type { RelayClient } from "@lilos/client-runtime";
import type {
  AppMessage,
  Ask,
  Conversation,
  RecentFolder,
} from "@lilos/contracts/app";
import type {
  ModelPick,
  ModelProviderRow,
  ModelRow,
  WorkspacePick,
} from "@lilos/ui-native";
import { atom } from "nanostores";
import { toModelCatalog } from "./dm-model";

/* Shared DM state (#156): open asks, folder recents, the engine model
   catalog, the composer's per-employee picks, and opens the phone itself
   sent (the "submitted" window before a summary row exists). Each watcher
   runs once per RelayClient — a re-paired Mac gets a fresh one. */

export const $asks = atom<Ask[]>([]);
export const $folders = atom<RecentFolder[]>([]);
export const $catalog = atom<{
  models: ModelRow[];
  providers: ModelProviderRow[];
  defaultModel?: string;
  defaultProvider?: string;
}>({ models: [], providers: [] });
export const $wsPicks = atom<Record<string, WorkspacePick>>({});
export const $modelPicks = atom<Record<string, ModelPick>>({});
export const $pendingOpens = atom<
  Map<string, { conversation: Conversation; root: AppMessage }>
>(new Map());

const watched = new WeakSet<RelayClient>();

/** Seed asks + recents + the model catalog, then track ask events live. */
export function watchDm(client: RelayClient): void {
  if (watched.has(client)) return;
  watched.add(client);

  const seed = () => {
    void client
      .request<{ asks: Ask[] }>("asks.list", {})
      .then((res) => $asks.set(res.asks))
      .catch(() => {});
    void client
      .request<{ folders: RecentFolder[] }>("folders.list", {})
      .then((res) => $folders.set(res.folders))
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
  };
  if (client.state.get() === "ready") seed();
  client.state.listen((s) => {
    if (s === "ready") seed();
  });

  client.onEvent((method, params) => {
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
