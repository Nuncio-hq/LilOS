import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  skipFirstRun,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";
import { openTroubleshooting } from "./helpers/status";

/**
 * Hire in the v3 shell (real stack: relay + harness on engine-fake). Hiring
 * creates a real agent on the engine: it shows in the sidebar and in People
 * at once, opens beside People, keeps the model that was picked, and is still
 * there after a reload. An engine that cannot create agents gets no Hire.
 */

const main = (page: Page) => page.locator("#v3-main");

test("Hire a Researcher: the new agent is in the sidebar and People, opened beside People, model kept, still there after a reload", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("v3hire", await pickPorts());
  try {
    await skipFirstRun(page);
    await page.goto(`${stack.webUrl}/`);
    const side = v3Sidebar(page);
    await expect(side.getByRole("button", { name: /Default/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(side.getByRole("button", { name: /Nova/ })).toHaveCount(0);

    await side.getByRole("button", { name: "Hire an agent" }).click();
    await expect(page).toHaveURL(/#\?page=hire$/);
    await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(
      "Hire an agent",
    );

    // Nothing to fill in until a role is picked; then the name follows it.
    await expect(
      main(page).getByRole("button", { name: "Hire", exact: true }),
    ).toHaveCount(0);
    await main(page)
      .getByRole("button", { name: /Researcher/ })
      .click();
    const name = main(page).getByPlaceholder("Name");
    await expect(name).toHaveValue("Researcher");
    await name.fill("Nova");
    // "Runs on" names the engine as it reported itself, once it has.
    await expect(main(page).locator("form")).toContainText("engine-fake", {
      ignoreCase: true,
      timeout: 30_000,
    });
    await main(page)
      .locator("form")
      .getByRole("button", { name: "Fake Reasoning", exact: true })
      .click();
    await main(page).getByRole("button", { name: "Hire", exact: true }).click();

    // Opened beside People, with the trail People › Nova.
    await expect(page).toHaveURL(/#\?page=people&open=agent:[^&,]+$/, {
      timeout: 30_000,
    });
    await expect(
      v3Peek(page).getByRole("navigation", { name: "Trail" }),
    ).toHaveText("People Nova", { useInnerText: true });
    await expect(v3Peek(page).getByRole("heading", { level: 1 })).toHaveText(
      "Nova",
    );
    await expect(v3Peek(page)).toContainText("Researcher");
    await expect(v3Peek(page)).toContainText("Fake Reasoning");
    await expect(v3Peek(page)).toContainText(
      "You research questions with cited sources and a one-paragraph answer first.",
    );
    await expect(v3Peek(page)).toContainText("Nothing assigned");

    // In the sidebar, beside the first agent, and in People as a row.
    await expect(side.getByRole("button", { name: /Nova/ })).toBeVisible();
    await expect(side.getByRole("button", { name: /Default/ })).toBeVisible();
    await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(
      "People",
    );
    /* Hire is the sidebar control only, not a link in this header.
       Count it only once describe has landed, or the gap reads as absent. */
    await expect(page.locator("[data-engine-described]")).toBeAttached();
    await expect(
      main(page).getByRole("button", { name: /Hire an agent/ }),
    ).toHaveCount(0);
    const row = main(page).getByRole("button", { name: /Nova/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Researcher");
    await expect(row).toContainText("Idle");
    await expect(main(page)).toContainText("2 agents");

    // It is the company's, not the tab's: a reload finds the same agent with
    // the same model, and the engine lists it as running there.
    await page.reload();
    await expect(v3Peek(page).getByRole("heading", { level: 1 })).toHaveText(
      "Nova",
      { timeout: 30_000 },
    );
    await expect(v3Peek(page)).toContainText("Fake Reasoning");
    await expect(side.getByRole("button", { name: /Nova/ })).toBeVisible();
    await page.goto(`${stack.webUrl}/#?page=settings&view=engine`);
    /* Agents on this engine sits inside Troubleshooting since #885 — the
       fold is closed when nothing is failing, so open it first. */
    await openTroubleshooting(page);
    await expect(
      main(page).getByRole("button", { name: /Nova/ }),
    ).toContainText("Connected", { timeout: 30_000 });
  } finally {
    await stack.stop();
  }
});

test("an engine that cannot create agents has no Hire: not in the sidebar, and its page says why", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("v3nohire", await pickPorts(), {
    LILOS_HIDE_CAPS: "agents",
  });
  try {
    await skipFirstRun(page);
    await page.goto(`${stack.webUrl}/`);
    const side = v3Sidebar(page);
    await expect(side.getByRole("button", { name: /Default/ })).toBeVisible({
      timeout: 30_000,
    });
    /* Hire is absent both before describe and when the engine declares no
       agents. The attribute is describe landing; the count is that state.
       Each goto mounts the shell again, so describe has to land again. */
    await expect(page.locator("[data-engine-described]")).toBeAttached();
    await expect(
      side.getByRole("button", { name: "Hire an agent" }),
    ).toHaveCount(0);
    await page.goto(`${stack.webUrl}/#?page=people`);
    await expect(page.locator("[data-engine-described]")).toBeAttached();
    await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(
      "People",
    );
    await expect(
      main(page).getByRole("button", { name: /Hire an agent/ }),
    ).toHaveCount(0);
    await page.goto(`${stack.webUrl}/#?page=people&view=org`);
    await expect(page.locator("[data-engine-described]")).toBeAttached();
    await expect(
      main(page).getByRole("button", { name: /Hire an agent/ }),
    ).toHaveCount(0);

    // A link to Hire still lands somewhere honest, with nothing to submit.
    await page.goto(`${stack.webUrl}/#?page=hire`);
    await expect(page.locator("[data-engine-described]")).toBeAttached();
    await expect(page.getByText(/Hiring is not available/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      main(page).getByRole("button", { name: /Researcher/ }),
    ).toHaveCount(0);
  } finally {
    await stack.stop();
  }
});
