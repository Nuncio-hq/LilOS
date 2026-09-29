import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { networkInterfaces } from "node:os";

/**
 * Tailscale self-address lookup (#153) — the injectable seam between the
 * relay and `tailscaled`. Ported from T3 Code
 * (`packages/tailscale/src/tailscale.ts`): `tailscale status --json` →
 * `Self.DNSName` (trailing dot stripped) + `Self.TailscaleIPs` filtered to
 * the CGNAT range (100.64.0.0/10). We run the plain CLI instead of their
 * Effect runtime and classify stderr to safe labels, never quoting it —
 * stderr can carry auth keys and node names.
 */

export interface TailscaleSelf {
  /** MagicDNS name (what the QR advertises) when the tailnet assigns one. */
  dnsName?: string;
  /** This Mac's CGNAT Tailscale IPv4s — the addresses we can bind. */
  ipv4s: string[];
}

export const TAILSCALE_STATUS_TIMEOUT_MS = 1_500;

/** True for addresses in Tailscale's CGNAT range (100.64.0.0/10). */
export function isTailscaleIpv4Address(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const [first, second, third, fourth] = parts.map((p) =>
    Number.parseInt(p, 10),
  );
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    [first, second, third, fourth].some(
      (p) => !Number.isInteger(p) || p < 0 || p > 255,
    )
  )
    return false;
  return first === 100 && second >= 64 && second <= 127;
}

/**
 * Parse `tailscale status --json` output. Returns null on malformed JSON;
 * a logged-out but running tailscaled yields `{ipv4s: []}` (treated as down
 * by the caller — there is nothing to bind).
 */
export function parseTailscaleStatus(raw: string): TailscaleSelf | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const self = (parsed as { Self?: unknown }).Self;
  if (typeof self !== "object" || self === null) return { ipv4s: [] };
  const dnsRaw = (self as { DNSName?: unknown }).DNSName;
  const dnsName =
    typeof dnsRaw === "string" ? dnsRaw.trim().replace(/\.$/, "") : undefined;
  const ipsRaw = (self as { TailscaleIPs?: unknown }).TailscaleIPs;
  const ipv4s = Array.isArray(ipsRaw)
    ? ipsRaw.filter(
        (ip): ip is string =>
          typeof ip === "string" && isTailscaleIpv4Address(ip),
      )
    : [];
  return {
    ...(dnsName ? { dnsName } : {}),
    ipv4s,
  };
}

/** Failure labels safe to log — raw stderr is never surfaced. */
export type TailscaleProbeError =
  | "missing"
  | "not-logged-in"
  | "permission-denied"
  | "timeout"
  | "error";

const STDERR_DIAGNOSTIC_PATTERNS: ReadonlyArray<
  readonly [
    RegExp,
    Exclude<TailscaleProbeError, "missing" | "timeout" | "error">,
  ]
> = [
  [/not logged in|logged out|needs? login/i, "not-logged-in"],
  [
    /permission denied|access denied|must be root|operation not permitted/i,
    "permission-denied",
  ],
];

export type TailscaleProbeResult =
  | { ok: true; self: TailscaleSelf }
  | { ok: false; reason: TailscaleProbeError };

/**
 * Run `tailscale status --json` once, bounded by TAILSCALE_STATUS_TIMEOUT_MS.
 * Any failure (binary missing, logged out, timeout) resolves to a typed
 * failure — callers treat every one of them as "Tailscale down".
 */
export function probeTailscale(
  bin = "tailscale",
  env: Record<string, string | undefined> = process.env,
): Promise<TailscaleProbeResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: TailscaleProbeResult) => {
      if (!done) {
        done = true;
        resolve(result);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["status", "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
        // The binary inside Tailscale.app decides between CLI and GUI from
        // its environment; under launchd (no TERM/SHLVL) it tries to start
        // the GUI and fails (#203). This asks it for the CLI explicitly.
        env: { ...env, TAILSCALE_BE_CLI: "1" },
      });
    } catch {
      finish({ ok: false, reason: "missing" });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: "timeout" });
    }, TAILSCALE_STATUS_TIMEOUT_MS);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish({ ok: false, reason: "missing" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const reason =
          STDERR_DIAGNOSTIC_PATTERNS.find(([re]) => re.test(stderr))?.[1] ??
          "error";
        finish({ ok: false, reason });
        return;
      }
      const self = parseTailscaleStatus(stdout);
      finish(self ? { ok: true, self } : { ok: false, reason: "error" });
    });
  });
}

/**
 * Where the Tailscale CLI lives on a Mac, most specific first (#203). The
 * installed app's relay runs as a LaunchAgent with
 * `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so a bare `tailscale` is never
 * found there. The app bundle comes before Homebrew: a Homebrew
 * `tailscale` talks to its own `tailscaled`, not the one the Tailscale app
 * runs, and reports it logged out.
 */
export const TAILSCALE_CLI_CANDIDATES: readonly string[] = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First executable candidate, else bare `tailscale` (PATH) as last resort. */
export function resolveTailscaleBin(
  candidates: readonly string[] = TAILSCALE_CLI_CANDIDATES,
  exists: (path: string) => boolean = isExecutable,
): string {
  return candidates.find(exists) ?? "tailscale";
}

type Interfaces = ReturnType<typeof networkInterfaces>;

/**
 * No CLI at all: read this Mac's interfaces for a CGNAT IPv4 (#203). Gives
 * an IP but no MagicDNS name. Never loopback (D-#153): only 100.64.0.0/10
 * addresses qualify.
 */
export function tailscaleFromInterfaces(
  ifaces: Interfaces = networkInterfaces(),
): TailscaleSelf | null {
  const ipv4s = Object.values(ifaces)
    .flatMap((list) => list ?? [])
    .filter(
      (a) =>
        a.family === "IPv4" && !a.internal && isTailscaleIpv4Address(a.address),
    )
    .map((a) => a.address);
  return ipv4s.length > 0 ? { ipv4s } : null;
}

/**
 * Resolve which probe the relay uses. `LILOS_RELAY_TAILSCALE_IP` (with
 * optional `LILOS_RELAY_TAILSCALE_NAME`) pins a static self-identity — the
 * dev/test seam for machines without tailscaled (CI, this repo's e2e).
 * `LILOS_TAILSCALE_BIN` overrides the binary path (a fake CLI in tests).
 * The default is the real CLI probe, with the binary found at a known
 * install location rather than on PATH (#203). Only when no CLI exists at
 * all does it fall back to this Mac's interfaces.
 */
export function resolveTailscaleProbe(
  env: Record<string, string | undefined> = process.env,
  deps: {
    candidates?: readonly string[];
    exists?: (path: string) => boolean;
    interfaces?: () => Interfaces;
  } = {},
): () => Promise<TailscaleProbeResult> {
  const ip = env.LILOS_RELAY_TAILSCALE_IP;
  if (ip) {
    const name = env.LILOS_RELAY_TAILSCALE_NAME;
    return async () => ({
      ok: true,
      self: { ipv4s: [ip], ...(name ? { dnsName: name } : {}) },
    });
  }
  const pinned = env.LILOS_TAILSCALE_BIN;
  return async () => {
    // Resolved per probe: installing Tailscale while LilOS runs just works.
    const bin = pinned ?? resolveTailscaleBin(deps.candidates, deps.exists);
    const result = await probeTailscale(bin, env);
    if (result.ok || result.reason !== "missing" || pinned) return result;
    const self = tailscaleFromInterfaces(
      deps.interfaces ? deps.interfaces() : undefined,
    );
    return self ? { ok: true, self } : result;
  };
}
