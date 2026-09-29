import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveTailscaleBin,
  resolveTailscaleProbe,
  TAILSCALE_CLI_CANDIDATES,
  tailscaleFromInterfaces,
} from "../src/tailscale";

/**
 * #203: the installed app's relay runs as a LaunchAgent whose PATH is
 * `/usr/bin:/bin:/usr/sbin:/sbin`, so a bare `tailscale` is never found.
 */
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const STATUS = JSON.stringify({
  Self: {
    DNSName: "oscar-m5pro.tail0000.ts.net.",
    TailscaleIPs: ["100.94.230.13", "fd7a:115c:a1e0::1"],
  },
});

/**
 * A fake of the binary inside Tailscale.app: without TAILSCALE_BE_CLI it
 * behaves like the real one under launchd and tries to start the GUI.
 */
function fakeCli(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$TAILSCALE_BE_CLI" != "1" ]; then
  echo "The Tailscale GUI failed to start" >&2
  exit 1
fi
cat <<'JSON'
${STATUS}
JSON
`,
  );
  chmodSync(path, 0o755);
  return path;
}

let dir: string;
let savedPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lilos-ts-"));
  savedPath = process.env.PATH;
  process.env.PATH = LAUNCHD_PATH;
});

afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

describe("#203 Tailscale CLI outside PATH", () => {
  it("AC-3 finds the CLI at a known install location under launchd's PATH", async () => {
    const bin = fakeCli(dir, "Tailscale");
    const probe = resolveTailscaleProbe(
      { PATH: LAUNCHD_PATH },
      { candidates: [join(dir, "missing"), bin] },
    );
    await expect(probe()).resolves.toEqual({
      ok: true,
      self: {
        dnsName: "oscar-m5pro.tail0000.ts.net",
        ipv4s: ["100.94.230.13"],
      },
    });
  });

  it("the app bundle wins over Homebrew, bare `tailscale` is the last resort", () => {
    expect(TAILSCALE_CLI_CANDIDATES[0]).toBe(
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    );
    expect(
      TAILSCALE_CLI_CANDIDATES.indexOf("/usr/local/bin/tailscale"),
    ).toBeLessThan(
      TAILSCALE_CLI_CANDIDATES.indexOf("/opt/homebrew/bin/tailscale"),
    );
    const present = new Set([
      "/usr/local/bin/tailscale",
      "/opt/homebrew/bin/tailscale",
    ]);
    expect(
      resolveTailscaleBin(TAILSCALE_CLI_CANDIDATES, (p) => present.has(p)),
    ).toBe("/usr/local/bin/tailscale");
    expect(resolveTailscaleBin(TAILSCALE_CLI_CANDIDATES, () => false)).toBe(
      "tailscale",
    );
  });

  it("no CLI anywhere: a CGNAT interface address stands in, never loopback", async () => {
    const probe = resolveTailscaleProbe(
      { PATH: LAUNCHD_PATH },
      {
        candidates: [],
        interfaces: () => ({
          lo0: [
            {
              address: "127.0.0.1",
              netmask: "255.0.0.0",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: true,
              cidr: "127.0.0.1/8",
            },
          ],
          utun4: [
            {
              address: "100.94.230.13",
              netmask: "255.255.255.255",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "100.94.230.13/32",
            },
          ],
        }),
      },
    );
    await expect(probe()).resolves.toEqual({
      ok: true,
      self: { ipv4s: ["100.94.230.13"] },
    });
  });

  it("AC-2 no CLI and no tailnet address: still Tailscale down", async () => {
    expect(
      tailscaleFromInterfaces({
        en0: [
          {
            address: "192.168.1.20",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: false,
            cidr: "192.168.1.20/24",
          },
        ],
      }),
    ).toBeNull();
    const probe = resolveTailscaleProbe(
      { PATH: LAUNCHD_PATH },
      { candidates: [], interfaces: () => ({}) },
    );
    await expect(probe()).resolves.toEqual({ ok: false, reason: "missing" });
  });

  it("a pinned LILOS_TAILSCALE_BIN is honored as-is (no interface fallback)", async () => {
    const probe = resolveTailscaleProbe(
      { LILOS_TAILSCALE_BIN: join(dir, "nope") },
      {
        interfaces: () => ({
          utun4: [
            {
              address: "100.94.230.13",
              netmask: "255.255.255.255",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "100.94.230.13/32",
            },
          ],
        }),
      },
    );
    await expect(probe()).resolves.toEqual({ ok: false, reason: "missing" });
  });
});
