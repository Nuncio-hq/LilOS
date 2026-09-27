import type { PairingOffer } from "@lilos/ui-native";
import { atom, map } from "nanostores";

/* The fake Mac behind the prototype — the mobile twin of the web prototype's
   fake engine. Every outcome is picked in Settings → Prototype or by deep link
   (lilos://preview?pair=expired&link=offline&scan=denied&reset=1), because the
   Simulator has no camera and a mock never fails on its own. The real calls
   are the relay's pairing exchange and reconnect (backend slice, #88). */

export type PairOutcome = "ok" | "unreachable" | "expired" | "hang";
export type LinkOutcome = "online" | "offline";
export type ScanOverride = "live" | "denied" | "invalid";

export const PAIR_OUTCOMES: { id: PairOutcome; label: string }[] = [
  { id: "ok", label: "Pairing succeeds" },
  { id: "unreachable", label: "Mac unreachable" },
  { id: "expired", label: "Code expired" },
  { id: "hang", label: "Stays connecting" },
];
export const LINK_OUTCOMES: { id: LinkOutcome; label: string }[] = [
  { id: "online", label: "Reconnects" },
  { id: "offline", label: "Mac offline" },
];
export const SCAN_OVERRIDES: { id: ScanOverride; label: string }[] = [
  { id: "live", label: "Real camera" },
  { id: "denied", label: "Camera denied" },
  { id: "invalid", label: "Scanned a wrong QR" },
];

export const $preview = map<{
  pair: PairOutcome;
  link: LinkOutcome;
  scan: ScanOverride;
}>({ pair: "ok", link: "online", scan: "live" });

/** Bumped when the link outcome changes so Home reconnects right away. */
export const $reconnectTick = atom(0);

/** What the fake Mac's Pair phone dialog shows (same values as the web prototype). */
export const DEMO_OFFER: PairingOffer = {
  host: "oscars-macbook-pro.tail1a2b.ts.net",
  code: "7K4M2P",
  name: "Oscar's MacBook Pro",
};

const pick = <T extends string>(v: string | null, all: { id: T }[]) =>
  all.find((o) => o.id === v)?.id;

/** Applies `pair=…&link=…&scan=…&reset=1` from a lilos://preview link. */
export function applyPreviewQuery(query: string): { reset: boolean } {
  const q = new URLSearchParams(query);
  const pair = pick(q.get("pair"), PAIR_OUTCOMES);
  const link = pick(q.get("link"), LINK_OUTCOMES);
  const scan = pick(q.get("scan"), SCAN_OVERRIDES);
  if (pair) $preview.setKey("pair", pair);
  if (scan) $preview.setKey("scan", scan);
  if (link) {
    $preview.setKey("link", link);
    $reconnectTick.set($reconnectTick.get() + 1);
  }
  return { reset: q.get("reset") === "1" };
}

export type PairResult =
  | { ok: true; name: string }
  | { ok: false; reason: "unreachable" | "expired" };

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });

export async function pairWithMac(
  offer: PairingOffer,
  signal: AbortSignal,
): Promise<PairResult> {
  const outcome = $preview.get().pair;
  if (outcome === "hang") return new Promise(() => {});
  await wait(outcome === "unreachable" ? 2200 : 1400, signal);
  if (outcome === "ok") return { ok: true, name: offer.name ?? "your Mac" };
  return { ok: false, reason: outcome };
}

/** Reconnect on launch: resolves true when the Mac answers. */
export async function reachMac(signal: AbortSignal): Promise<boolean> {
  const online = $preview.get().link === "online";
  await wait(online ? 900 : 1800, signal);
  return online;
}
