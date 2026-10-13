import type { DesktopBridge, DesktopBridgeConfig } from "@lilos/contracts/app";
import type { EngineEventType } from "@lilos/contracts/engine";

/** Runtime wiring for the app: where the relay and the engine endpoint are. */
export type LilosConfig = DesktopBridgeConfig & {
  /** e2e/dev knob: `?statusPollMs=500` shortens the 15s system.status poll. */
  statusPollMs?: number;
  /* e2e knob (#685): `?feedHold=turn.completed:400` holds matching feed
     events for the ms before dispatch — reproduces the relay-beats-feed
     reorder a loaded CI runner opens. Inert when absent. */
  feedHold?: { type: EngineEventType; ms: number };
};

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
    return {
      ...window.lilos.config,
      ...(statusPollMs ? { statusPollMs } : {}),
      ...(feedHold ? { feedHold } : {}),
    };
  }
  const res = await fetch("/lilos-config.json", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      `No LilOS config: start the stack with \`bun run dev\` or open LilOS.app (GET /lilos-config.json returned ${res.status})`,
    );
  }
  const cfg = (await res.json()) as Partial<LilosConfig>;
  if (!cfg.relayWs || !cfg.engineWs) {
    throw new Error("Malformed /lilos-config.json: need relayWs + engineWs");
  }
  return {
    relayWs: cfg.relayWs,
    relayToken: cfg.relayToken ?? "",
    engineWs: cfg.engineWs,
    ...(statusPollMs ? { statusPollMs } : {}),
    ...(feedHold ? { feedHold } : {}),
  };
}
