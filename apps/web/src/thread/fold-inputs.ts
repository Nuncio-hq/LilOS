import type { SessionModel } from "@lilos/client-runtime";
import type { Conversation } from "@lilos/contracts/app";
import type { FoldInputs } from "../lib/conv-fold";

/* #467: an engine-backed conversation can anchor replies only once its
   feed's attach watermark is stamped — before that, engine-post rows would
   paint unanchored below newer user rows for a frame. "pending" holds them
   (and the partial model live frames alone would mint) until the first
   replay lands; a terminal replay error latches attached too so the #28
   degraded thread keeps the raw relay view. Non-engine conversations are
   always bound — there is no feed to wait on. #572: neither are sessions
   the watch doesn't feed — an unwatched conversation has no replay coming,
   so its relay rows render as-is instead of being held back. */
export function boundModelFor(
  conv: Conversation,
  models: Record<string, SessionModel>,
  feedAttached: Record<string, boolean>,
  watched: Record<string, boolean>,
): SessionModel | "pending" | undefined {
  const sid = conv.engineRef;
  if (!sid) return undefined;
  const bound = feedAttached[sid] === true || watched[sid] !== true;
  return bound ? models[sid] : "pending";
}

/* The fold's inputs for one conversation. #572: the resolved attachment URLs
   key the fold — a watched session's replay churn used to hide that the
   chips' urls bake at fold time; an unwatched one folds once and needs the
   explicit input or thumbnails never appear (ac-112). */
export function foldInputsFor(
  a: Omit<FoldInputs, "urls"> & { attachUrls: Record<string, string> },
): FoldInputs {
  const { attachUrls, ...rest } = a;
  const refs = [
    ...(a.root?.attachments ?? []),
    ...a.msgs.flatMap((m) => m.attachments ?? []),
  ];
  return {
    ...rest,
    urls: refs.length ? refs.map((r) => attachUrls[r.id]) : undefined,
  };
}
