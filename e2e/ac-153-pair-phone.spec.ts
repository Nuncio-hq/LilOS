import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts } from "./helpers/stack";

/**
 * Issue #153 — Pair phone in the real app (relay + harness + vite,
 * engine-fake). The Tailscale probe is env-seamed: the stack either points
 * LILOS_TAILSCALE_BIN at a missing binary (dialog must say Tailscale is off)
 * or pins a fake tailnet identity via LILOS_RELAY_TAILSCALE_* (a real second
 * bind on this machine's LAN address stands in for the CGNAT IP). The phone
 * leg is the real HTTP exchange endpoint — no fake scan. Screenshots land in
 * test-results/ac153/ for the PR.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac153");
mkdirSync(SHOTS, { recursive: true });

/** Physical-interface IPv4 first: tunnel/virtual ifaces (utun, awdl, llw,
    bridge) on a dev Mac can blackhole connects instead of refusing. */
function lanAddress(): string | undefined {
  const physical: string[] = [];
  const other: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal)
        (name.startsWith("en") ? physical : other).push(a.address);
    }
  }
  return physical[0] ?? other[0];
}

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

/** The app only offers the sidebar after onboarding — skip the gate. */
async function openApp(page: Page, webUrl: string) {
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await page.goto(`${webUrl}/`);
  await expect(
    page.locator("aside").getByRole("button", { name: /Default/ }),
  ).toBeVisible({ timeout: 30_000 });
}

const openPairPhone = async (page: Page) => {
  await page.locator("[data-pairphone-open]").click();
  return page.locator("[data-pairphone]");
};

test.describe.configure({ timeout: 120_000 });

test("AC-1/AC-6 Tailscale down → Pair phone says so, no QR", async ({
  page,
}) => {
  // No tailscaled: the honest "not installed" probe failure.
  const stack = await bootStack("153down", await pickPorts(), {
    LILOS_TAILSCALE_BIN: "/nonexistent-tailscale-bin",
  });
  try {
    const errors = watchConsole(page);
    await openApp(page, stack.webUrl);
    const dialog = await openPairPhone(page);
    await expect(dialog).toHaveAttribute("data-pairphone", "no-remote");
    await expect(page.getByText("Turn on Tailscale first")).toBeVisible();
    await expect(page.locator("[data-pairqr]")).toHaveCount(0);
    await page.screenshot({ path: path.join(SHOTS, "1-no-tailscale.png") });
    expect(errors).toEqual([]);
  } finally {
    await stack.stop();
  }
});

test("AC-2/AC-4/AC-6 grant shows a QR, exchange pairs, revoke drops it", async ({
  page,
}) => {
  const lan = lanAddress();
  test.skip(!lan, "no LAN address for the tailnet-bind stand-in");
  const stack = await bootStack("153up", await pickPorts(), {
    LILOS_RELAY_TAILSCALE_IP: lan,
    LILOS_RELAY_TAILSCALE_NAME: "mac.tailnet.test",
  });
  try {
    const errors = watchConsole(page);
    await openApp(page, stack.webUrl);
    const dialog = await openPairPhone(page);
    await expect(dialog).toHaveAttribute("data-pairphone", "ready");

    // QR encodes the fragment-carried grant; the offer rows show it chunked.
    await expect(page.locator("[data-pairqr] svg")).toBeVisible();
    const address = await page
      .locator('[data-pair-value="Address"]')
      .innerText();
    const shownCode = await page
      .locator('[data-pair-value="Code"]')
      .innerText();
    // The advertised port is the tailnet listener's — the same config port
    // the loopback listener took.
    expect(address).toBe(`mac.tailnet.test:${new URL(stack.relayWs).port}`);
    expect(shownCode).toMatch(
      /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/,
    );
    await expect(page.locator("[data-expiry]")).toContainText("Works once");
    await page.screenshot({ path: path.join(SHOTS, "2-qr-ready.png") });

    // The phone: real HTTP exchange against the tailnet listener, code read
    // off the dialog exactly as scanned.
    const tsPort = Number(address.split(":")[1]);
    const exchanged = await fetch(`http://${lan}:${tsPort}/pair/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: shownCode.replaceAll("-", ""),
        name: "E2E iPhone",
      }),
      signal: AbortSignal.timeout(10_000),
    }).then(
      (r) => r.json() as Promise<{ deviceId: string; credential: string }>,
    );
    expect(exchanged.deviceId).toMatch(/^dev_/);

    // devices.changed flips the open dialog to paired and lists the phone.
    await expect(dialog).toHaveAttribute("data-pairphone", "paired");
    await expect(page.getByText("E2E iPhone is paired")).toBeVisible();
    const row = page.locator("[data-pairphone-device]");
    await expect(row).toHaveCount(1);
    await expect(row.first()).toContainText("E2E iPhone");
    await page.screenshot({ path: path.join(SHOTS, "3-paired.png") });

    // AC-4: Remove → the row disappears and the credential dies.
    await row.first().locator("[data-pairphone-revoke]").click();
    await expect(row).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await stack.stop();
  }
});

test("AC-2 dialog refreshes the code after expiry", async ({ page }) => {
  const lan = lanAddress();
  test.skip(!lan, "no LAN address for the tailnet-bind stand-in");
  const stack = await bootStack("153ttl", await pickPorts(), {
    LILOS_RELAY_TAILSCALE_IP: lan,
    LILOS_RELAY_TAILSCALE_NAME: "mac.tailnet.test",
    LILOS_PAIRING_TTL_MS: "2500",
  });
  try {
    await openApp(page, stack.webUrl);
    const dialog = await openPairPhone(page);
    await expect(dialog).toHaveAttribute("data-pairphone", "ready");
    const first = await page.locator('[data-pair-value="Code"]').innerText();

    // Expiry state: dimmed QR + "New code" — the grant is dead server-side.
    await expect(page.locator("[data-expiry]")).toContainText("expired", {
      timeout: 10_000,
    });
    await page.screenshot({ path: path.join(SHOTS, "4-expired.png") });
    await page.locator("[data-newcode]").click();
    await expect(page.locator("[data-expiry]")).toContainText("Works once");
    const second = await page.locator('[data-pair-value="Code"]').innerText();
    expect(second).not.toBe(first);
    await page.screenshot({ path: path.join(SHOTS, "5-new-code.png") });
  } finally {
    await stack.stop();
  }
});
