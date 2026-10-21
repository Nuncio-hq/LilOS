import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  advertisedPairingHost,
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
    DNSName: "mac.example.ts.net.",
    TailscaleIPs: ["100.64.1.2", "fd7a:115c:a1e0::1"],
  },
});

/**
 * A fake of the binary inside Tailscale.app: without TAILSCALE_BE_CLI it
 * behaves like the real one under launchd and tries to start the GUI.
 */
function fakeCli(dir: string, name: string, json = STATUS): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$TAILSCALE_BE_CLI" != "1" ]; then
  echo "The Tailscale GUI failed to start" >&2
  exit 1
fi
cat <<'JSON'
${json}
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
        dnsName: "mac.example.ts.net",
        ipv4s: ["100.64.1.2"],
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
              address: "100.64.1.2",
              netmask: "255.255.255.255",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "100.64.1.2/32",
            },
          ],
        }),
      },
    );
    await expect(probe()).resolves.toEqual({
      ok: true,
      self: { ipv4s: ["100.64.1.2"] },
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
              address: "100.64.1.2",
              netmask: "255.255.255.255",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "100.64.1.2/32",
            },
          ],
        }),
      },
    );
    await expect(probe()).resolves.toEqual({ ok: false, reason: "missing" });
  });
});

/**
 * #803: which host the pairing QR names. iOS ATS allows `*.ts.net` and
 * RFC 1918, not 100.64.0.0/10, and the exception list is not widened.
 */
describe("#803 pairing address", () => {
  it("MagicDNS known → the ts.net name, not the 100.x address", () => {
    expect(
      advertisedPairingHost({
        dnsName: "mac.example.ts.net",
        ipv4s: ["100.64.1.2"],
      }),
    ).toBe("mac.example.ts.net");
  });

  it("only a 100.x IP known → that literal", () => {
    /* Documented degraded case: no MagicDNS name (interface fallback,
       CLI down, MagicDNS off). The QR carries the CGNAT literal. iOS ATS
       refuses it (NSURLError -1022). We do not invent a hostname. */
    expect(advertisedPairingHost({ ipv4s: ["100.64.1.2"] })).toBe("100.64.1.2");
  });

  it("a LAN address is unchanged when no MagicDNS name is known", () => {
    expect(advertisedPairingHost({ ipv4s: ["192.168.1.20"] })).toBe(
      "192.168.1.20",
    );
    expect(
      advertisedPairingHost({
        dnsName: "mac.tailnet.test",
        ipv4s: ["192.168.1.20"],
      }),
    ).toBe("mac.tailnet.test");
  });

  it("a CGNAT pin with no name learns *.ts.net from tailscale status --json", async () => {
    const bin = fakeCli(
      dir,
      "tailscale",
      JSON.stringify({
        Self: {
          DNSName: "Mac.Example.ts.net.",
          TailscaleIPs: ["100.99.8.7"],
        },
      }),
    );
    const probe = resolveTailscaleProbe({
      LILOS_RELAY_TAILSCALE_IP: "100.64.1.2",
      LILOS_TAILSCALE_BIN: bin,
    });
    const result = await probe();
    expect(result).toEqual({
      ok: true,
      self: { ipv4s: ["100.64.1.2"], dnsName: "mac.example.ts.net" },
    });
    if (result.ok) {
      expect(advertisedPairingHost(result.self)).toBe("mac.example.ts.net");
    }
  });

  it("a CGNAT pin and no CLI keeps the literal (still a bind, not down)", async () => {
    const probe = resolveTailscaleProbe({
      LILOS_RELAY_TAILSCALE_IP: "100.64.1.2",
      LILOS_TAILSCALE_BIN: join(dir, "missing-tailscale"),
    });
    const result = await probe();
    expect(result).toEqual({
      ok: true,
      self: { ipv4s: ["100.64.1.2"] },
    });
    if (result.ok) {
      expect(advertisedPairingHost(result.self)).toBe("100.64.1.2");
    }
  });

  it("a CGNAT pin whose status has no MagicDNS name keeps the literal", async () => {
    const bin = fakeCli(
      dir,
      "tailscale",
      JSON.stringify({
        Self: { DNSName: "mac.tailnet.test.", TailscaleIPs: ["100.64.1.2"] },
      }),
    );
    const probe = resolveTailscaleProbe({
      LILOS_RELAY_TAILSCALE_IP: "100.64.1.2",
      LILOS_TAILSCALE_BIN: bin,
    });
    const result = await probe();
    expect(result).toEqual({
      ok: true,
      self: { ipv4s: ["100.64.1.2"] },
    });
    if (result.ok) {
      expect(advertisedPairingHost(result.self)).toBe("100.64.1.2");
    }
  });

  it("status --json without a *.ts.net name does not invent one", async () => {
    const bin = fakeCli(
      dir,
      "tailscale",
      JSON.stringify({
        Self: { DNSName: "", TailscaleIPs: ["100.64.1.2"] },
      }),
    );
    const probe = resolveTailscaleProbe(
      { PATH: LAUNCHD_PATH, LILOS_TAILSCALE_BIN: bin },
      { candidates: [] },
    );
    const result = await probe();
    expect(result).toEqual({
      ok: true,
      self: { ipv4s: ["100.64.1.2"] },
    });
    if (result.ok) {
      expect(advertisedPairingHost(result.self)).toBe("100.64.1.2");
    }
  });

  it("a LAN pin does not consult tailscale", async () => {
    const marker = join(dir, "cli-was-run");
    const bin = join(dir, "tailscale");
    writeFileSync(bin, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(bin, 0o755);
    const probe = resolveTailscaleProbe({
      LILOS_RELAY_TAILSCALE_IP: "192.168.1.20",
      LILOS_TAILSCALE_BIN: bin,
    });
    await expect(probe()).resolves.toEqual({
      ok: true,
      self: { ipv4s: ["192.168.1.20"] },
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("an explicit name on a CGNAT pin is the QR host and skips status", async () => {
    const marker = join(dir, "cli-was-run");
    const bin = join(dir, "tailscale");
    writeFileSync(bin, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(bin, 0o755);
    const probe = resolveTailscaleProbe({
      LILOS_RELAY_TAILSCALE_IP: "100.64.1.2",
      LILOS_RELAY_TAILSCALE_NAME: "mac.example.ts.net",
      LILOS_TAILSCALE_BIN: bin,
    });
    const result = await probe();
    expect(result).toEqual({
      ok: true,
      self: { ipv4s: ["100.64.1.2"], dnsName: "mac.example.ts.net" },
    });
    if (result.ok) {
      expect(advertisedPairingHost(result.self)).toBe("mac.example.ts.net");
    }
    expect(existsSync(marker)).toBe(false);
  });
});
