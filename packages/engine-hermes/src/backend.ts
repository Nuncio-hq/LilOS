/**
 * #482: the adapter's `hermes serve` watchdog.
 *
 * Before this, the adapter spawned the backend once and never looked at it
 * again: the child could die (or its socket drop) while the adapter kept
 * `state: running` and parked every engine call on a dead socket — the
 * 15-second hangs Oscar saw. This supervisor owns the whole lifecycle:
 *
 *   spawn `hermes serve` → connect the gateway → watch BOTH the child exit
 *   and the socket close → mark the engine down so calls fail fast typed →
 *   relaunch with backoff → swap in the new gateway (`setGateway`), leaving
 *   sessions to lazily `session.resume` their stored row on next touch.
 *
 * A backend that keeps crashing gives up after `maxAttempts` consecutive
 * failures (`failed`) — the adapter stays up, calls still fail typed, and a
 * later call `kick()`s the budget back open on demand.
 */
import { unlinkSync, writeFileSync } from "node:fs";
import { type GatewayLike, HermesGateway } from "./gateway.js";
import {
  HermesHostConflict,
  type HermesServeHandle,
  startHermesServe,
} from "./serve.js";

/** How to reach the backend this supervisor owns — the engine needs it to
    hit token-gated HTTP endpoints (`/api/dashboard/agent-plugins/activate`,
    #549) the JSON-RPC gateway has no verb for. */
export interface BackendEndpoint {
  url: string;
  token: string;
}

export interface HermesBackendOptions {
  /** Path to the `hermes` binary. */
  bin: string;
  /** Extra argv for `hermes serve`. */
  args?: string[];
  /** Ready timeout for each spawn. Default 240s (cold agent builds). */
  spawnTimeoutMs?: number;
  /** First relaunch delay; doubles to `maxBackoffMs`. Default 250ms. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** A child surviving this long resets the crash budget. Default 30s. */
  stableAfterMs?: number;
  /** Consecutive failures before `failed`. Default 5. */
  maxAttempts?: number;
  /** Live pid file — rewritten on every spawn (#482 live leg kills by pid,
      never by name, so it can only ever hit the child this adapter owns). */
  pidFile?: string;
  /** One-line state transitions for the adapter's own stdout — the harness
      launcher mirrors its stdout into the harness log, which is where the
      live leg proves death→restart. */
  onLog?: (line: string) => void;
}

/** The slice of `HermesEngine` the supervisor drives — kept as an interface
    so the watcher file never imports the whole engine. */
export interface BackendReactor {
  /** The live gateway, plus the backend's own endpoint (absent in tests
      that stub the supervisor — activation is best-effort anyway). */
  setGateway(gw: GatewayLike, backend?: BackendEndpoint): void;
  markBackendDown(detail: string, state?: "restarting" | "failed"): void;
  markBackendFailed(detail: string): void;
}

interface Live {
  gw: GatewayLike;
  handle: HermesServeHandle;
  gen: number;
}

export class HermesBackendSupervisor {
  private readonly spawnTimeoutMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly stableAfterMs: number;
  private readonly maxAttempts: number;

  private reactor?: BackendReactor;
  private live?: Live;
  private generation = 0;
  private failures = 0;
  private down?: string;
  private relaunchTimer?: ReturnType<typeof setTimeout>;
  private stableTimer?: ReturnType<typeof setTimeout>;
  private relaunching?: Promise<void>;
  private closed = false;

  constructor(private opts: HermesBackendOptions) {
    this.spawnTimeoutMs = opts.spawnTimeoutMs ?? 240_000;
    this.minBackoffMs = opts.minBackoffMs ?? 250;
    this.maxBackoffMs = opts.maxBackoffMs ?? 10_000;
    this.stableAfterMs = opts.stableAfterMs ?? 30_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  private log(line: string) {
    this.opts.onLog?.(line);
  }

  /**
   * First spawn — errors propagate (a dead hermes at boot is the launcher's
   * call, same as before #482). Returns the live gateway.
   */
  async start(): Promise<GatewayLike> {
    const { gw, handle } = await this.spawnOnce();
    this.attachLive(gw, handle);
    this.armStable();
    return gw;
  }

  /** Point the supervisor at the engine. Replays `down` if the backend died
      between `start()` and this call so the engine can't miss the flip. */
  attachReactor(r: BackendReactor) {
    this.reactor = r;
    if (this.down !== undefined)
      r.markBackendDown(this.down, this.failed() ? "failed" : "restarting");
    else {
      const { gw, handle } = this.mustLive();
      r.setGateway(gw, { url: handle.url, token: handle.token });
    }
  }

  /** Re-arm a spent budget on demand — `HermesEngine` calls this when a
      caller touches the engine while `failed` (opt-in retry, not a loop). */
  kick() {
    if (this.closed || this.down === undefined || !this.failed()) return;
    this.log("hermes backend: re-arming on demand");
    this.failures = 0;
    this.reactor?.markBackendDown(this.down, "restarting");
    this.scheduleRelaunch(0);
  }

  private failed() {
    return this.failures >= this.maxAttempts;
  }

  private mustLive(): Live {
    if (!this.live) throw new Error("hermes backend: nothing live");
    return this.live;
  }

  /** The one spawn+connect unit — protected so tests can drive the watcher
      without a real `hermes serve`/gateway behind it. */
  protected async spawnOnce(): Promise<{
    gw: GatewayLike;
    handle: HermesServeHandle;
  }> {
    const handle = await startHermesServe({
      bin: this.opts.bin,
      ...(this.opts.args ? { args: this.opts.args } : {}),
      timeoutMs: this.spawnTimeoutMs,
    });
    try {
      const gw = await HermesGateway.connect(
        `ws://127.0.0.1:${handle.port}/api/ws?token=${handle.token}`,
      );
      return { gw, handle };
    } catch (e) {
      await handle.close().catch(() => {});
      throw e;
    }
  }

  private attachLive(gw: GatewayLike, handle: HermesServeHandle) {
    const gen = ++this.generation;
    this.live = { gw, handle, gen };
    if (this.opts.pidFile && handle.child.pid !== undefined) {
      try {
        writeFileSync(this.opts.pidFile, `${handle.child.pid}\n`);
      } catch {
        /* pid file is best-effort evidence for the live leg */
      }
    }
    gw.onClose(() => {
      if (this.live?.gen !== gen) return;
      this.lost("gateway socket closed");
    });
    handle.child.once("exit", (code, signal) => {
      if (this.live?.gen !== gen) return;
      this.lost(
        signal
          ? `hermes serve killed by ${signal}`
          : `hermes serve exited code ${code}`,
      );
    });
  }

  private lost(detail: string) {
    if (this.closed || this.down !== undefined) return;
    this.down = detail;
    this.failures += 1;
    this.log(`hermes backend down: ${detail}`);
    /* A dead child's stable-timer must not reset the crash budget
       mid-outage — it's only meaningful while the backend is up. */
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
    const dead = this.live;
    this.live = undefined;
    if (dead) {
      dead.gw.close();
      void dead.handle.close().catch(() => {});
    }
    if (this.failed()) {
      this.log(
        `hermes backend failed after ${this.failures} consecutive failures — engine stays down until a call re-arms it`,
      );
      try {
        this.reactor?.markBackendFailed(detail);
      } catch (e) {
        this.log(`markBackendFailed threw: ${String(e)}`);
      }
      return;
    }
    try {
      this.reactor?.markBackendDown(detail, "restarting");
    } catch (e) {
      /* A reactor throw must never skip the relaunch — the whole point
         of the watchdog is that the backend comes back. */
      this.log(`markBackendDown threw: ${String(e)}`);
    }
    this.scheduleRelaunch();
  }

  private scheduleRelaunch(delayMs?: number) {
    if (this.closed) return;
    const delay =
      delayMs ??
      Math.min(
        this.minBackoffMs * 2 ** Math.max(0, this.failures - 1),
        this.maxBackoffMs,
      );
    this.relaunchTimer = setTimeout(() => void this.relaunch(), delay);
  }

  private async relaunch() {
    if (this.closed || this.down === undefined) return;
    if (this.relaunching) return this.relaunching;
    this.relaunching = (async () => {
      try {
        const { gw, handle } = await this.spawnOnce();
        if (this.closed || this.down === undefined) {
          /* A second loss landed while spawning — retire this child too. */
          gw.close();
          void handle.close().catch(() => {});
          return;
        }
        this.down = undefined;
        this.attachLive(gw, handle);
        this.armStable();
        this.log(`hermes backend up at ${handle.url}`);
        this.reactor?.setGateway(gw, {
          url: handle.url,
          token: handle.token,
        });
      } catch (e) {
        this.failures += 1;
        const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
        this.log(`hermes backend relaunch failed (${msg ?? e})`);
        /* #548: a host-owner conflict is a verdict, not a crash — the other
           backend keeps owning this host until someone stops it, so fail
           now instead of burning the budget. It still counts as spent so
           `kick()` can re-arm once the owner is gone. */
        if (e instanceof HermesHostConflict) this.failures = this.maxAttempts;
        if (this.failed()) {
          try {
            this.reactor?.markBackendFailed(
              `relaunch failed: ${msg ?? "unknown"}`,
            );
          } catch {
            /* the state is logged either way */
          }
          return;
        }
        this.scheduleRelaunch();
      } finally {
        this.relaunching = undefined;
      }
    })();
    return this.relaunching;
  }

  private armStable() {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.failures = 0;
    }, this.stableAfterMs);
  }

  /** First-boot token probe failure path: exit-code for "hermes too old" is
      decided by the caller; the supervisor just stops restarting. */
  async close() {
    this.closed = true;
    if (this.relaunchTimer) clearTimeout(this.relaunchTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    /* An in-flight spawn gets a bounded moment to land — its own closed
       check then retires the child instead of orphaning a `hermes serve`
       holding a port+token. Bounded because serve.ts exits right after. */
    if (this.relaunching)
      await Promise.race([
        this.relaunching,
        new Promise((r) => setTimeout(r, 2_000)),
      ]);
    const dead = this.live;
    this.live = undefined;
    if (dead) {
      dead.gw.close();
      await dead.handle.close().catch(() => {});
    }
    if (this.opts.pidFile) {
      try {
        unlinkSync(this.opts.pidFile);
      } catch {
        /* already gone */
      }
    }
  }
}
