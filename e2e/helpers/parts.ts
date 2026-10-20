/**
 * The dev slice as three separate processes (relay, harness, vite) so a spec
 * can kill or restart one leg while the others keep running — what the
 * `bun run dev` umbrella of `bootStack` cannot do: it exits the moment any
 * child dies. Same spawn recipe as ac-28 / ac-130 / ac-557, shared here for
 * the status specs (ac-33, ac-53).
 *
 * The relay and harness readiness is identity-checked like `bootStack`'s, and
 * the app's own vite uses the per-worker cache dir so two vite servers never
 * share an optimizer (#84).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { engineTag, expectNoEngineLeak } from "../engine-leak";
import {
  captureProc,
  killProc,
  type StackPorts,
  WORKER,
  waitForFeed,
  waitForHttp,
  waitForRelay,
  waitForToken,
} from "./stack";

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/helpers
const repo = path.resolve(here, "../..");
const webDir = path.join(repo, "apps", "web");

type Part = "relay" | "harness" | "web";

export interface Parts {
  home: string;
  webUrl: string;
  ports: StackPorts;
  relayWs: string;
  relayToken: string;
  /** LILOS_ENGINE_TAG the harness's engine carries — for leak checks. */
  leakTag: string;
  /** Kill one part (its whole process group) and wait for it to exit. */
  kill: (which: Part) => Promise<void>;
  /** Respawn the relay on the same home + port, so the install token stays
      valid and a reconnecting client finds it. */
  restartRelay: () => Promise<void>;
  /** Everything every part printed so far, in arrival order per part. */
  log: () => string;
  stop: () => Promise<void>;
}

async function spawnRelay(
  home: string,
  port: number,
  logs: (() => string)[],
): Promise<ChildProcess> {
  const p = spawn("bun", ["run", "apps/relay/src/index.ts"], {
    cwd: repo,
    detached: true,
    env: {
      ...process.env,
      LILOS_RELAY_HOME: home,
      LILOS_RELAY_PORT: String(port),
      LILOS_RELAY_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = captureProc(p);
  logs.push(out);
  await waitForRelay(port, p, out);
  return p;
}

/**
 * Boot relay → harness → vite on `ports`. `opts.harness: false` leaves the
 * harness out (the page then sees a relay with no host), `opts.harnessEnv`
 * overrides the harness's env (`LILOS_ENGINE`, `HERMES_BIN`, …).
 */
export async function bootParts(
  tag: string,
  ports: StackPorts,
  opts: { harness?: boolean; harnessEnv?: Record<string, string> } = {},
): Promise<Parts> {
  const home = mkdtempSync(path.join(tmpdir(), `lilos-e2e-${tag}-`));
  const leakTag = engineTag(tag);
  const procs: Record<Part, ChildProcess | undefined> = {
    relay: undefined,
    harness: undefined,
    web: undefined,
  };
  const logs: (() => string)[] = [];
  const relayWs = `ws://127.0.0.1:${ports.relay}/ws`;
  const stop = async () => {
    for (const k of ["web", "harness", "relay"] as const) {
      const p = procs[k];
      procs[k] = undefined;
      if (p) await killProc(p);
    }
    await expectNoEngineLeak(leakTag);
  };
  try {
    procs.relay = await spawnRelay(home, ports.relay, logs);
    const relayToken = await waitForToken(home);

    if (opts.harness !== false) {
      const harness = spawn("bun", ["run", "apps/harness/src/index.ts"], {
        cwd: repo,
        detached: true,
        env: {
          ...process.env,
          LILOS_ENGINE: "fake",
          LILOS_RELAY_URL: relayWs,
          LILOS_RELAY_HOME: home,
          LILOS_RELAY_TOKEN: relayToken,
          LILOS_HARNESS_HOME: path.join(home, "harness"),
          LILOS_REPO_ROOT: repo,
          LILOS_WORKDIR: path.join(home, "harness", "work"),
          LILOS_FEED_PORT: String(ports.feed),
          LILOS_ENGINE_TAG: leakTag,
          ...opts.harnessEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      procs.harness = harness;
      const out = captureProc(harness);
      logs.push(out);
      await waitForFeed(ports.feed, harness, out);
    }

    procs.web = spawn(
      "bun",
      [
        path.join(webDir, "node_modules", ".bin", "vite"),
        "--config",
        path.join(webDir, "vite.ac28.config.ts"),
        "--host",
        "127.0.0.1",
        "--port",
        String(ports.web),
        "--strictPort",
      ],
      {
        cwd: webDir,
        detached: true,
        env: {
          ...process.env,
          LILOS_RELAY_WS: relayWs,
          LILOS_RELAY_TOKEN: relayToken,
          LILOS_ENGINE_WS: `ws://127.0.0.1:${ports.feed}/ws`,
          LILOS_WEB_PORT: String(ports.web),
          LILOS_VITE_CACHE_DIR: `node_modules/.vite-${tag}-w${WORKER}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    logs.push(captureProc(procs.web));
    await waitForHttp(`http://127.0.0.1:${ports.web}`, 60_000, procs.web);

    return {
      home,
      webUrl: `http://127.0.0.1:${ports.web}`,
      ports,
      relayWs,
      relayToken,
      leakTag,
      kill: async (which) => {
        const p = procs[which];
        procs[which] = undefined;
        if (p) await killProc(p);
      },
      restartRelay: async () => {
        procs.relay = await spawnRelay(home, ports.relay, logs);
      },
      log: () => logs.map((l) => l()).join("\n"),
      stop,
    };
  } catch (e) {
    // A half-booted stack must not keep its ports or its engine.
    await stop().catch(() => {});
    throw e;
  }
}
