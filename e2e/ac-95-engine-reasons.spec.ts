import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #95 — engine start failures read plainly.
 * Boots the real `bun run dev` stack (same pattern as e2e/ac-85-real-engine.spec.ts)
 * with a stub HERMES_BIN:
 *
 *   AC-1: the stub prints an old version → status dialog + DM composer say
 *         `Hermes <found> is too old — LilOS needs <min> or newer. Run \`hermes update\`.`
 *         and the harness stops retrying (fatal — it won't fix itself).
 *   AC-2: the stub `kill -9`s itself → after the retry budget the same two
 *         surfaces say `The engine was stopped by the system (SIGKILL) — a
 *         device security policy may be blocking it.`
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-95");

/** Bare JSON-RPC seed client (same as ac-85). */
async function rpc(
  relayWs: string,
  token: string,
  calls: { method: string; params: Record<string, unknown> }[],
): Promise<Record<string, unknown>[]> {
  const ws = new WebSocket(`${relayWs}?token=${encodeURIComponent(token)}`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws connect failed"));
  });
  const pending = new Map<string, (r: Record<string, unknown>) => void>();
  ws.onmessage = (e) => {
    const f = JSON.parse(e.data as string) as Record<string, unknown>;
    if (typeof f.id === "string") pending.get(f.id)?.(f);
  };
  const send = (id: string, method: string, params: object) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      pending.set(id, (f) =>
        f.error
          ? rej(new Error(`${method} -> ${JSON.stringify(f.error)}`))
          : res(f),
      );
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  await send("h", "session.hello", { protocolVersion: 1, token });
  const out: Record<string, unknown>[] = [];
  for (const [i, c] of calls.entries())
    out.push(await send(String(i), c.method, c.params));
  ws.close();
  return out;
}

/** Executable stub standing in for the `hermes` binary. */
function stubHermes(name: string, body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `lilos-stub-${name}-`));
  const bin = path.join(dir, "hermes");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** Engine down → no auto-hire: seed the employee + DM over the relay. */
async function seedDm(stack: Stack): Promise<string> {
  const [created] = await rpc(stack.relayWs, stack.relayToken, [
    {
      method: "employees.create",
      params: {
        name: "Default",
        role: "Founder's engineer",
        profile: "default",
        status: "online",
      },
    },
  ]);
  const employeeId = (created.result as { employee: { id: string } }).employee
    .id;
  await rpc(stack.relayWs, stack.relayToken, [
    { method: "channels.openDm", params: { employeeId } },
  ]);
  return employeeId;
}

test.describe.configure({ mode: "serial" });

test("AC-1 (#95) a too-old Hermes reads plainly — status dialog + DM composer", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stub = stubHermes(
    "old",
    'if [ "$1" = "--version" ]; then echo "Hermes Agent v0.20.2"; exit 0; fi\nexit 0',
  );
  const stack = await bootStack("oldhermes", await pickPorts(), {
    LILOS_ENGINE: "hermes",
    HERMES_BIN: stub,
  });
  try {
    const employeeId = await seedDm(stack);
    await page.goto(`${stack.webUrl}/dm/${employeeId}?statusPollMs=500`);

    const note = page.locator("[data-composer-note]");
    await expect(note).toBeVisible({ timeout: 60_000 });
    await expect(note).toContainText(
      "Hermes 0.20.2 is too old — LilOS needs 0.21.5 or newer. Run hermes update.",
    );
    // #99 AC-1: the command renders as inline code, not literal backticks.
    await expect(note.locator("code")).toHaveText("hermes update");
    await expect(note).not.toContainText("`");
    // #99 AC-3: the note keeps a visible gap above the composer box (the
    // prompt form is the note's next rendered sibling inside the composer).
    const gap = await note.evaluate((el) => {
      const form = el.parentElement?.querySelector("form");
      return form
        ? form.getBoundingClientRect().top - el.getBoundingClientRect().bottom
        : Number.NaN;
    });
    expect(gap).toBeGreaterThanOrEqual(6);
    // #99 AC-2: presence dots don't read "online" while the engine is down.
    await expect(page.locator("[data-presence]").first()).toBeVisible();
    await expect(page.locator('[data-presence="online"]')).toHaveCount(0);
    for (const size of [
      { width: 1288, height: 700 },
      { width: 900, height: 700 },
    ]) {
      await page.setViewportSize(size);
      await page.screenshot({ path: `${SHOTS}/ac-1-dm-${size.width}.png` });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.screenshot({ path: `${SHOTS}/ac-1-dm.png` });

    await page.getByRole("button", { name: "System status" }).click();
    const dialog = page.getByRole("dialog", { name: "System status" });
    const reason = dialog
      .locator("p")
      .filter({ hasText: /Hermes 0\.20\.2 is too old/ });
    await expect(reason).toHaveText(
      "Hermes 0.20.2 is too old — LilOS needs 0.21.5 or newer. Run hermes update.",
    );
    await expect(reason.locator("code")).toHaveText("hermes update");
    await page.screenshot({ path: `${SHOTS}/ac-1-status.png` });

    // Fatal verdict: the harness must NOT be retrying — one probe, no loop.
    const logs = stack.harnessLog();
    expect(logs).toContain("too old");
    expect(logs).not.toMatch(/start failed, retrying/);
  } finally {
    await stack.stop();
  }
});

test("AC-2 (#95) a SIGKILLed engine names the signal and the policy hint", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Every invocation — the `--version` probe and `serve` — self-SIGKILLs,
  // like the work-Mac device policy that kills any *hermes* process.
  const stub = stubHermes("sigkill", "kill -9 $$");
  const stack = await bootStack("killedhermes", await pickPorts(), {
    LILOS_ENGINE: "hermes",
    HERMES_BIN: stub,
  });
  try {
    const employeeId = await seedDm(stack);
    await page.goto(`${stack.webUrl}/dm/${employeeId}?statusPollMs=500`);

    const note = page.locator("[data-composer-note]");
    await expect(note).toBeVisible({ timeout: 120_000 });
    await expect(note).toContainText(
      "The engine was stopped by the system (SIGKILL) — a device security policy may be blocking it.",
    );
    await page.screenshot({ path: `${SHOTS}/ac-2-dm.png` });

    await page.getByRole("button", { name: "System status" }).click();
    const dialog = page.getByRole("dialog", { name: "System status" });
    await expect(
      dialog.getByText(
        "The engine was stopped by the system (SIGKILL) — a device security policy may be blocking it.",
        { exact: true },
      ),
    ).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/ac-2-status.png` });
  } finally {
    await stack.stop();
  }
});
