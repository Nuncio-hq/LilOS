import { expect, type Page, test } from "@playwright/test";

/* Issue #29 — hire / edit / remove employees against a REAL engine: the dev
   server serves POST /api/engine → a live @lilos/engine-fake instance, so
   "Use profile" lists actual engine profiles, "New profile" runs
   `agents.create` for real, and removal never deletes a profile.
   State is shared (one engine per dev server), so the file is serial and each
   test uses unique names. */

const ENGINE_URL = "http://127.0.0.1:5199/api/engine";
let rpcSeq = 0;
async function engineCall<T>(
  request: {
    post(
      url: string,
      o: { data: unknown },
    ): Promise<{ json(): Promise<unknown> }>;
  },
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const res = await request.post(ENGINE_URL, {
    data: { jsonrpc: "2.0", id: `e2e-${++rpcSeq}`, method, params },
  });
  const frame = (await res.json()) as {
    result?: T;
    error?: { message: string };
  };
  if (frame.error) throw new Error(`${method}: ${frame.error.message}`);
  return frame.result as T;
}
const agentIds = async (
  request: Parameters<typeof engineCall>[0],
): Promise<string[]> => {
  const { agents } = await engineCall<{ agents: { id: string }[] }>(
    request,
    "agents.list",
  );
  return agents.map((a) => a.id);
};

const sidebar = (page: Page) => page.locator("aside").first();
const openHire = async (page: Page) => {
  await sidebar(page).getByRole("button", { name: "Hire employee" }).click();
  await expect(page.getByRole("button", { name: "Use profile" })).toBeVisible();
};

test.describe
  .serial("issue #29 employee lifecycle", () => {
    test.beforeAll(async ({ request }) => {
      // One un-hired seed profile so AC-1 has an enabled row.
      const ids = await agentIds(request);
      if (!ids.includes("researcher")) {
        await engineCall(request, "agents.create", {
          name: "researcher",
          soul: "You are Researcher. Cited answers first.",
          model: "fake-small",
        });
      }
    });

    test("AC-1+6 Use profile lists real engine profiles; hired ones disabled; no who-can-direct", async ({
      page,
    }) => {
      await page.goto("/");
      await openHire(page);
      // All three seed profiles are already hired -> disabled rows.
      for (const id of ["builder", "reviewer", "marketer"]) {
        const row = page.getByRole("button", {
          name: new RegExp(`\\b${id}\\b`),
        });
        await expect(row).toBeDisabled();
        await expect(row).toContainText("hired");
      }
      // The fresh engine profile is enabled and hireable.
      const row = page.getByRole("button", { name: /researcher.*skills/ });
      await expect(row).toBeEnabled();
      await expect(row).toContainText("skills");
      await row.click();
      // Read-only profile card: model + skill count + SOUL preview.
      await expect(page.getByText("fake-small")).toBeVisible();
      await expect(page.getByText("Cited answers first")).toBeVisible();
      // AC-6: single user — no who-can-direct picker in either mode.
      await expect(page.getByText(/Who can direct/i)).toHaveCount(0);
      await page.getByRole("button", { name: "New profile" }).click();
      await expect(page.getByText(/Who can direct/i)).toHaveCount(0);
      await page.getByRole("button", { name: "Use profile" }).click();
      await page.getByRole("button", { name: /researcher.*skills/ }).click();
      await page.getByRole("button", { name: /Hire researcher/i }).click();
      // Hired: sidebar entry + profile card shows the linked profile.
      await expect(
        sidebar(page).getByRole("button", { name: /researcher/ }),
      ).toBeVisible();
      await expect(page.getByText("researcher").first()).toBeVisible();
    });

    test("AC-2 New profile creates a real engine profile and hires it", async ({
      page,
      request,
    }) => {
      await page.goto("/");
      const before = await agentIds(request);
      expect(before).not.toContain("auditor");

      await openHire(page);
      await page.getByRole("button", { name: "New profile" }).click();
      await page.getByRole("button", { name: "Blank" }).click();
      await page.getByPlaceholder("Tester").fill("Auditor");
      await page.getByPlaceholder("QA automation").fill("Compliance");
      await page
        .locator("textarea")
        .last()
        .fill("You are Auditor. You check process and cite clauses.");
      await page.getByRole("button", { name: "Fake Reasoning" }).click();
      await page.getByRole("button", { name: /Hire Auditor/ }).click();

      // Employee exists in the sidebar…
      await expect(
        sidebar(page).getByRole("button", { name: /Auditor/ }),
      ).toBeVisible();
      // …and the engine profile is real.
      await expect
        .poll(async () => (await agentIds(request)).includes("auditor"))
        .toBe(true);
      const { agent } = await engineCall<{ agent: { soul?: string } }>(
        request,
        "agents.describe",
        { id: "auditor" },
      );
      expect(agent.soul).toContain("Auditor");
    });

    test("AC-3 edit display name + role", async ({ page }) => {
      await page.goto("/");
      await sidebar(page)
        .getByRole("button", { name: /Marketer/ })
        .click();
      await page.getByRole("button", { name: "Profile" }).click();
      await page.getByRole("button", { name: "Edit" }).click();
      await page.getByLabel(/Display name/i).fill("Marketer One");
      await page.getByLabel(/Role/i).fill("Growth lead");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(
        sidebar(page).getByRole("button", { name: /Marketer One/ }),
      ).toBeVisible();
      await expect(page.getByText("Growth lead").first()).toBeVisible();
    });

    test("AC-4 remove deletes only the LilOS record; profile stays on the engine", async ({
      page,
      request,
    }) => {
      await page.goto("/");
      await sidebar(page)
        .getByRole("button", { name: /Builder/ })
        .click();
      await page.getByRole("button", { name: "Profile" }).click();
      await page.getByRole("button", { name: "Edit" }).click();
      await page.getByRole("button", { name: /Remove from company/ }).click();
      await expect(
        page.getByText(/its sessions, memory, and skills/),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Remove from company" })
        .last()
        .click();
      await expect(
        sidebar(page).getByRole("button", { name: /Builder/ }),
      ).toHaveCount(0);
      expect(await agentIds(request)).toContain("builder");
    });

    test("AC-5 profile missing shows the missing state + Switch profile", async ({
      page,
    }) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Preview states" }).click();
      await page
        .getByRole("menuitemradio", { name: "Profile missing" })
        .click();
      await sidebar(page)
        .getByRole("button", { name: /Marketer/ })
        .click();
      await page.getByRole("button", { name: "Profile" }).click();
      // Scoped to the profile panel: under load the "Preview states" menu can
      // still be closing, and its "Profile missing" radio matches too.
      const panel = page.getByRole("tabpanel", { name: "Employee" });
      await expect(panel.getByText(/Profile missing/)).toBeVisible();
      await page.getByText(/Switch profile/).click();
      await page.getByRole("option", { name: /reviewer/ }).click();
      await expect(panel.getByText(/Profile missing/)).toHaveCount(0);
    });
  });
