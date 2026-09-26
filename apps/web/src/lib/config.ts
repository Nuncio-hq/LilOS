import type { DesktopBridge, DesktopBridgeConfig } from "@lilos/contracts/app";

/** Runtime wiring for the app: where the relay and the engine endpoint are. */
export type LilosConfig = DesktopBridgeConfig;

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
  if (window.lilos?.config) return window.lilos.config;
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
  };
}
