import { atom } from "nanostores";
import { resetDmStore } from "../dm-store";
import { $client, $link, $welcome, stopLink } from "../link";
import { $phase, type PairedMac } from "../paired-macs";
import { resetPrs } from "../prs";
import { DemoClient } from "./client";

/* Demo lifecycle (#168 AC-1/AC-4): `enterDemo` swaps the live RelayClient
   for a DemoClient behind the same AppClient surface — screens never
   branch on it. `exitDemo` closes it and drops every demo atom; pairing a
   real Mac afterwards goes through the same `startLink` path as a fresh
   launch, so nothing demo-owned survives into a real session. */

/** True while the demo world is the connected one. Gates the demo-only
    chrome (badge, Exit demo) and silences push registration — the demo
    never asks for the OS notification prompt. */
export const $demo = atom<boolean>(false);

/** The in-memory pairing row the Mac sheet renders while in demo — never
    persisted (`savePairedMac`/`touchMac` only run from startLink). */
export const DEMO_MAC: PairedMac = {
  id: "demo-mac",
  name: "Demo Mac",
  host: "demo.local",
  route: "local",
  pairedAt: 0,
  lastSeenAt: 0,
  deviceId: "demo-device",
  credential: "demo",
};

/** Enter the demo: a fully offline world behind the client interface. */
export async function enterDemo(): Promise<void> {
  stopLink();
  /* Entering from a live link leaves the real directory's residue (asks,
     recents, PRs) — drop it before the demo seeds its own. */
  resetDmStore();
  resetPrs();
  const client = new DemoClient();
  $demo.set(true);
  $client.set(client);
  $link.set("online");
  $welcome.set(await client.connect());
  /* The navigator keys on phase — flipping it lands on Home with the demo
     directory already baked (same ordering as a real startLink). */
  $phase.set("app");
}

/** Exit the demo: close the fake world and land back on Welcome. AC-4 —
    leaves nothing in the directory cache or the keychain: the demo never
    writes either (snapshot saves only run under `startLink`), so only the
    in-memory atoms need clearing — a previously paired Mac's cache is left
    exactly as it was. */
export function exitDemo(): void {
  stopLink();
  $demo.set(false);
  resetDmStore();
  resetPrs();
  /* Back to Welcome: the phase flip remounts the nav tree, so any pending
     offer/pair-pick replays on the fresh onboarding stack. */
  $phase.set("onboarding");
}
