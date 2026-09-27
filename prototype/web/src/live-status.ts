import {
  formatDiagnostics,
  RelayClient,
  toStatusComponents,
} from "@lilos/client-runtime";
import type { StatusMismatch } from "@lilos/contracts/app";
import type { StatusComponent } from "@lilos/ui";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import packageJson from "../package.json";

/**
 * Live system status for issue #33: `?statusRelay=ws://…&statusToken=…` swaps
 * the scenario mock for the real `system.status` poll — same StatusRow /
 * StatusDialog / StatusBanner, fed by the relay + harness + engine chain.
 * Polls carry logLines so Copy diagnostics always has a fresh tail.
 */
export interface LiveStatus {
  components: StatusComponent[];
  diagnostics: string;
  mismatch?: StatusMismatch;
  connected: boolean;
}

const useAtom = <T>(store: {
  subscribe: (listener: () => void) => () => void;
  get: () => T;
}): T => useSyncExternalStore(store.subscribe, store.get);

export function useLiveStatus(): LiveStatus | null {
  const params = useMemo(
    () => new URLSearchParams(window.location.search),
    [],
  );
  const url = params.get("statusRelay");
  const token = params.get("statusToken") ?? undefined;
  const pollMs = Number.parseInt(params.get("statusPollMs") ?? "5000", 10);

  const client = useMemo(() => {
    if (!url || !token) return null;
    return new RelayClient({
      url,
      token,
      client: { name: "prototype", version: packageJson.version },
    });
  }, [url, token]);

  useEffect(() => {
    if (!client) return;
    void client.connect().catch(() => {});
    const stop = client.startStatusPolling(
      Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 5_000,
      25,
    );
    return () => {
      stop();
      client.close();
    };
  }, [client, pollMs]);

  const status = useAtom(client?.status ?? NULL_STATUS);
  const fatal = useAtom(client?.fatal ?? NULL_FATAL);

  return useMemo(() => {
    if (!client) return null;
    const components = toStatusComponents({
      result: status.result,
      connection: status.connection,
      fatal,
    });
    return {
      components,
      diagnostics: formatDiagnostics({
        result: status.result,
        connection: status.connection,
        fatal,
        error: status.error,
        app: { name: "lilos-prototype", version: packageJson.version },
      }),
      mismatch: status.result?.mismatch,
      connected: status.connection === "ready",
    };
  }, [client, status, fatal]);
}

/* Null-stores keep the hook call order stable when live mode is off.
   get() must return a stable reference — a fresh object per call makes
   useSyncExternalStore loop forever. */
const IDLE_STATUS = { connection: "idle" as const };
const NULL_STATUS = {
  subscribe: () => () => {},
  get: () => IDLE_STATUS,
};
const NULL_FATAL = {
  subscribe: () => () => {},
  get: () => undefined,
};
