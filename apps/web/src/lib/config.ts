import type { DesktopBridge, DesktopBridgeConfig } from "@lilos/contracts/app";
import type { EngineEventType } from "@lilos/contracts/engine";
import { atom } from "nanostores";

/** Runtime wiring for the app: where the relay and the engine endpoint are. */
export type LilosConfig = DesktopBridgeConfig & {
  /** e2e/dev knob: `?statusPollMs=500` shortens the 15s system.status poll. */
  statusPollMs?: number;
  /* e2e knob (#685): `?feedHold=<event>:<ms>` holds matching feed
     events for the ms before dispatch — reproduces the relay-beats-feed
     reorder a loaded CI runner opens. Inert when absent. */
  feedHold?: { type: EngineEventType; ms: number };
  /* D-#836's `company` flag comes with the base DesktopBridgeConfig — a
     served `company: true` (LILOS_COMPANY=1 stack) or a bridge config that
     sets it shows the paused company layer back. */
};

/* D-#836's one switch: the layer shows when the served config asks for it
   (LILOS_COMPANY=1 stack) or this tab's URL carries `?company=1` — the nav
   lives in the hash, so the search param stays on across navigation. */
export const companyLayerOn = (
  search: string,
  cfg?: { company?: boolean },
): boolean =>
  cfg?.company === true || new URLSearchParams(search).get("company") === "1";

/** The resolved boot config. The v3 data store reads the company flag off
   it; set by loadConfig before the app first renders. */
export const appConfig = atom<LilosConfig | undefined>(undefined);

declare global {
  interface Window {
    /** Injected by the Electron preload (apps/desktop); absent in plain web. */
    lilos?: DesktopBridge;
  }
}

/**
 * Resolution order: Electron preload bridge → dev/preview server's
 * /lilos-config.json. No fallback is invented — a missing config is a real
 * setup error and surfaces in the boot screen.
 */
export async function loadConfig(): Promise<LilosConfig> {
  const params = new URLSearchParams(window.location.search);
  const statusPollMs = Number(params.get("statusPollMs"));
  /* `?feedHold=<event>:<ms>` — hold that feed event type per session
     before dispatch (#685's claim-window repro). */
  const [holdType, holdMs] = (params.get("feedHold") ?? "").split(":");
  const feedHold =
    holdType && Number(holdMs) > 0
      ? { type: holdType as EngineEventType, ms: Number(holdMs) }
      : undefined;
  if (window.lilos?.config) {
    const cfg: LilosConfig = {
      ...window.lilos.config,
      company: companyLayerOn(window.location.search, window.lilos.config),
      ...(statusPollMs ? { statusPollMs } : {}),
      ...(feedHold ? { feedHold } : {}),
    };
    appConfig.set(cfg);
    return cfg;
  }
  const res = await fetch("/lilos-config.json", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      `No LilOS config: start the stack with \`bun run dev\` or open LilOS.app (GET /lilos-config.json returned ${res.status})`,
    );
  }
  const raw = (await res.json()) as Partial<LilosConfig>;
  if (!raw.relayWs || !raw.engineWs) {
    throw new Error("Malformed /lilos-config.json: need relayWs + engineWs");
  }
  const cfg: LilosConfig = {
    relayWs: raw.relayWs,
    relayToken: raw.relayToken ?? "",
    engineWs: raw.engineWs,
    company: companyLayerOn(window.location.search, raw),
    ...(statusPollMs ? { statusPollMs } : {}),
    ...(feedHold ? { feedHold } : {}),
  };
  appConfig.set(cfg);
  return cfg;
}
