import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * #762 prototype: an agent's notes (its only memory) and skills, and the
 * company skill library. Mock company. Shots land in test-results/762-proto.
 * The agent stays in the side peek, so the note toast can be checked against
 * the seam between the page and the peek.
 */

const OUT = "test-results/762-proto";

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true });
});

const shot = async (page: Page, theme: string, name: string) => {
  await page.screenshot({ path: `${OUT}/${theme}-${name}.png` });
};

const chipLabels = (page: Page) =>
  page
    .locator("[data-agent-skills]")
    .getByRole("button", { name: /^Detach / })
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: notes, skills, and the library`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?page=people&open=agent:scout&theme=${theme}`);
    await expect(
      page.locator(theme === "dark" ? "html.dark" : "html:not(.dark)"),
    ).toBeAttached();
    const peek = page.locator('aside[aria-label="Opened record"]');
    await expect(peek.getByRole("heading", { level: 1 })).toHaveText("Scout");
    await expect(
      peek.getByRole("heading", { name: "Instructions" }),
    ).toBeVisible();

    const notes = peek.locator("[data-agent-notes]");
    await notes.scrollIntoViewIfNeeded();
    await expect(peek.getByRole("heading", { name: /^Notes/ })).toHaveCount(1);
    await expect(peek.getByRole("heading", { name: /Remembers/ })).toHaveCount(
      0,
    );
    await expect(peek.getByText(/^Remembers$/)).toHaveCount(0);
    const readers = notes.getByRole("button", { name: /readers\.md/ });
    await expect(readers).toContainText("HeardBack readers are mostly women");
    await expect(readers).toContainText("from HB-9");
    await expect(
      notes.getByRole("button", { name: /creators\.md/ }),
    ).toBeVisible();
    await shot(page, theme, "notes-list");

    await readers.click();
    await page.mouse.move(0, 0);
    await expect(readers).toHaveClass(/inset_2px_0_0/);
    await expect(readers).toHaveAttribute("aria-current", "true");
    const openNote = notes.locator("article");
    await expect(openNote.getByText("A reminder beats an ad.")).toBeVisible();
    await expect(openNote).not.toContainText("- A reminder");
    await shot(page, theme, "note-open");

    await notes.getByRole("button", { name: "Edit" }).click();
    const body = notes.getByRole("textbox", { name: "Note", exact: true });
    await expect(body).toBeVisible();
    await body.fill(
      "HeardBack readers journal at night.\n\nEdited in the prototype.",
    );
    await body.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shot(page, theme, "note-edit");
    await notes.getByRole("button", { name: "Save" }).click();
    const toast = page.locator("[data-toast]");
    await expect(toast).toHaveText("Note saved");
    await expect(toast).toHaveAttribute("data-toast-panel", "");
    const toastBox = await toast.boundingBox();
    const peekBox = await peek.boundingBox();
    expect(toastBox).toBeTruthy();
    expect(peekBox).toBeTruthy();
    if (toastBox && peekBox) {
      expect(toastBox.x).toBeGreaterThanOrEqual(peekBox.x - 2);
      expect(toastBox.x + toastBox.width).toBeLessThanOrEqual(
        peekBox.x + peekBox.width + 2,
      );
    }
    await shot(page, theme, "note-toast");
    await expect(notes.getByText("Edited in the prototype.")).toBeVisible();
    await expect(toast).toHaveCount(0, { timeout: 5_000 });

    const skills = peek.locator("[data-agent-skills]");
    await skills.scrollIntoViewIfNeeded();
    await expect(skills.getByText("Not using")).toHaveCount(0);
    expect(await chipLabels(page)).toEqual([
      "Detach web-research",
      "Detach creator-vetting",
      "Detach sheets",
    ]);
    await skills.getByRole("button", { name: "+ Add skill" }).click();
    const menu = page.getByRole("menu", { name: "Add a skill" });
    await expect(menu).toBeVisible();
    await menu.getByLabel("Find a skill").fill("brand");
    await expect(
      menu.getByRole("menuitem", { name: /brand-voice/ }),
    ).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /planning/ })).toHaveCount(
      0,
    );
    await shot(page, theme, "skills-menu");
    await menu.getByRole("menuitem", { name: /brand-voice/ }).click();
    expect(await chipLabels(page)).toEqual([
      "Detach web-research",
      "Detach creator-vetting",
      "Detach sheets",
      "Detach brand-voice",
    ]);
    await skills.getByRole("button", { name: "Detach web-research" }).click();
    expect(await chipLabels(page)).toEqual([
      "Detach creator-vetting",
      "Detach sheets",
      "Detach brand-voice",
    ]);

    await skills.getByRole("button", { name: "Library" }).click();
    await expect(page).toHaveURL(/page=settings&view=skills/);
    const main = page.locator("#v3-main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(
      "Settings",
    );
    const research = main.getByRole("button", { name: /web-research/ });
    await research.click();
    await page.mouse.move(0, 0);
    await expect(research).toHaveClass(/inset_2px_0_0/);
    await expect(main.locator("[data-skill-view]")).toContainText(
      "Cite every row.",
    );
    await main.getByLabel("Filter skills").fill("web");
    await expect(main.getByRole("button", { name: /planning/ })).toHaveCount(0);
    await expect(research).toBeVisible();
    const detail = main.locator("[data-skill-detail]");
    const list = main.locator("[data-skill-list]");
    await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(detail).toBeVisible();
    const detailBox = await detail.boundingBox();
    const view = page.viewportSize();
    expect(detailBox && view && detailBox.y < view.height).toBeTruthy();
    await shot(page, theme, "skills-list");

    await main.getByRole("button", { name: "Add skill" }).click();
    await expect(main.locator("[data-skill-view]")).toHaveCount(0);
    await expect(main.getByText("Cite every row.")).toHaveCount(0);
    await main.locator('input[type="file"]').setInputFiles({
      name: "launch-notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Launch\nAsk before anything goes public.\n"),
    });
    await expect(main.getByLabel("Name")).toHaveValue("launch-notes");
    await expect(main.locator("[data-skill-slug]")).toHaveText("launch-notes");
    await expect(main.getByLabel("Skill text")).toHaveValue(
      "# Launch\nAsk before anything goes public.\n",
    );
    await shot(page, theme, "add-skill");
    await main.getByRole("button", { name: "Add", exact: true }).click();
    const added = main.getByRole("button", { name: /launch-notes/ });
    await expect(added).toHaveAttribute("aria-current", "true");
    await expect(added).toHaveClass(/inset_2px_0_0/);
    const addedBox = await added.boundingBox();
    const listBox = await list.boundingBox();
    expect(addedBox && listBox).toBeTruthy();
    if (addedBox && listBox) {
      expect(addedBox.y).toBeGreaterThanOrEqual(listBox.y - 2);
      expect(addedBox.y).toBeLessThanOrEqual(listBox.y + listBox.height + 2);
    }
    const skill = main.locator("[data-skill-view]");
    await expect(
      skill.getByRole("heading", { name: "Launch", exact: true }),
    ).toBeVisible();
    await expect(skill).not.toContainText("# Launch");
    await expect(page.locator("[data-toast]")).toHaveCount(0, {
      timeout: 5_000,
    });
    await shot(page, theme, "skill-added");
  });
}
