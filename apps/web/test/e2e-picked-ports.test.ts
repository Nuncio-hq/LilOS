/**
 * Issue #689 — ac-659's x20 repeat leg flaked once at the boot wait (run
 * 37568441335): vite died EADDRINUSE because engine-fake's `--port 0` took
 * the port `pickPorts()` had just probed free. `freePort` drew from the
 * kernel's ephemeral range — the same pool every `bind(0)` listener and
 * outbound `connect()` source port comes from — so any stack child could
 * steal a picked port in the release→bind gap, and `page.goto` then loaded
 * engine-fake's HTTP answer instead of the app. Picks must land strictly
 * below the ephemeral floor, which that allocator never re-issues.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { freePort, pickPorts } from "../../../e2e/helpers/stack";

/** The kernel's ephemeral floor, read independently of the code under test:
    Linux `ip_local_port_range`, macOS `portrange.first`, 32768 otherwise —
    the lowest default across Linux/macOS/Windows. */
const ephemeralFloor = (): number => {
  try {
    const lo = Number(
      readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
        .trim()
        .split(/\s+/)[0],
    );
    if (Number.isFinite(lo) && lo > 1024) return lo;
  } catch {
    /* not Linux */
  }
  try {
    const lo = Number(
      execFileSync("sysctl", ["-n", "net.inet.ip.portrange.first"], {
        encoding: "utf8",
      }).trim(),
    );
    if (Number.isFinite(lo) && lo > 1024) return lo;
  } catch {
    /* not macOS */
  }
  return 32_768;
};

const bindZero = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

describe("AC-1 (#689) a picked port is unreachable by the ephemeral allocator", () => {
  it("freePort/pickPorts return ports strictly below the ephemeral floor", async () => {
    const floor = ephemeralFloor();
    const singles = await Promise.all(
      Array.from({ length: 8 }, () => freePort()),
    );
    const trio = await pickPorts();
    for (const port of [...singles, trio.relay, trio.feed, trio.web]) {
      expect(port, `picked ${port} is inside the ephemeral range`).toBeLessThan(
        floor,
      );
    }
  });

  it("AC-2 this host never answers bind(0) with a port below the floor", async () => {
    /* The assumption the pick range leans on — pin it so a host with a
       wider configured ephemeral range fails loudly here instead of
       flaking a spec somewhere else. */
    const floor = ephemeralFloor();
    const bound = await Promise.all(
      Array.from({ length: 200 }, () => bindZero()),
    );
    for (const port of bound) {
      expect(port).toBeGreaterThanOrEqual(floor);
    }
  });

  it("AC-3 a picked port is still free to bind when the child claims it", async () => {
    /* The probe must keep doing its job: the port is genuinely free, not
       merely below the floor. */
    const port = await freePort();
    const srv = createServer();
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
});
