import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * #762 prototype: an agent's notes (its only memory) and skills, and the
 * company skill library. Mock company. Shots land in test-results/762-proto.
 * The agent stays in the side peek. Saving a note and adding a skill leave
 * no toast: the row is the confirmation.
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
    await expect(page.locator("[data-toast]")).toHaveCount(0);
    const saved = notes.getByRole("button", { name: /readers\.md/ });
    await expect(saved).toContainText("just now");
    await expect(notes.getByText("Edited in the prototype.")).toBeVisible();

    const skills = peek.locator("[data-agent-skills]");
    await skills.scrollIntoViewIfNeeded();
    await expect(skills.getByText("Not using")).toHaveCount(0);
    expect(await chipLabels(page)).toEqual([
      "Detach web-research",
      "Detach creator-vetting",
      "Detach sheets",
    ]);
    const addSkill = skills.getByRole("button", { name: "+ Add skill" });
    await addSkill.evaluate((el) => {
      const scroller = el.closest("[data-v3-scroller]");
      if (!(scroller instanceof HTMLElement)) return;
      const s = scroller.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      scroller.scrollTop += r.bottom - (s.bottom - 16);
    });
    await addSkill.click();
    const menu = page.getByRole("menu", { name: "Add a skill" });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("data-menu-place", "up");
    await expect(menu).toHaveClass(/overflow-y-auto/);
    await expect(menu).toHaveClass(/max-h-/);
    expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
      true,
    );
    await shot(page, theme, "skills-menu");
    await menu.getByLabel("Find a skill").fill("brand");
    await expect(
      menu.getByRole("menuitem", { name: /brand-voice/ }),
    ).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /planning/ })).toHaveCount(
      0,
    );
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

    const addBtn = main.getByRole("button", { name: "Add skill" });
    const before = await addBtn.boundingBox();
    const listBefore = await list.boundingBox();
    await addBtn.click();
    const after = await addBtn.boundingBox();
    const listAfter = await list.boundingBox();
    expect(before && after && Math.abs(after.y - before.y)).toBeLessThan(2);
    expect(
      listBefore && listAfter && Math.abs(listAfter.y - listBefore.y),
    ).toBeLessThan(2);
    await expect(addBtn).toBeDisabled();
    await expect(addBtn).toHaveAttribute("aria-pressed", "true");
    await expect(main.locator("[aria-current]")).toHaveCount(0);
    await expect(main.locator("[data-skill-view]")).toHaveCount(0);
    await expect(main.locator("[data-add-skill]")).toBeVisible();
    await expect(main.getByText("Cite every row.")).toHaveCount(0);
    await shot(page, theme, "add-skill");

    await main.getByLabel("Name").fill("typescript");
    await main.getByLabel("Skill text").fill("Again.");
    await expect(
      main.getByText("A skill already has that name."),
    ).toBeVisible();
    await expect(
      main.getByRole("button", { name: "Add", exact: true }),
    ).toBeDisabled();
    await shot(page, theme, "skill-duplicate");

    await main.getByLabel("Name").fill("!!!");
    await expect(main.getByText("Use letters or numbers.")).toBeVisible();
    await expect(main.locator("[data-skill-slug]")).toHaveCount(0);
    await expect(
      main.getByRole("button", { name: "Add", exact: true }),
    ).toBeDisabled();
    await shot(page, theme, "skill-letters");

    await main.locator('input[type="file"]').setInputFiles({
      name: "launch-notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "# Launch\nAsk before anything goes public.\n\nWarm the cups.\n",
      ),
    });
    await expect(main.getByLabel("Name")).toHaveValue("launch-notes");
    await expect(main.locator("[data-skill-slug]")).toHaveCount(0);
    await expect(main.getByLabel("Description")).toHaveValue(
      "Ask before anything goes public.",
    );
    await expect(main.getByLabel("Skill text")).not.toHaveValue(
      /Ask before anything goes public/,
    );
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
    expect(
      (await skill.innerText()).split("Ask before anything goes public.")
        .length,
    ).toBe(2);
    await expect(page.locator("[data-toast]")).toHaveCount(0);
    await shot(page, theme, "skill-added");

    await page.goto(`/?page=people&open=agent:builder&theme=${theme}`);
    const builder = page.locator('aside[aria-label="Opened record"]');
    const verify = builder.locator("[data-agent-notes]");
    await verify.getByRole("button", { name: /verify\.md/ }).click();
    const paras = verify.locator("article .lilos-prose p");
    await expect(paras).toHaveCount(2);
    await expect(paras.nth(0)).toContainText("bun run verify");
    await expect(paras.nth(1)).toContainText("Never push to main");
    await shot(page, theme, "verify-note");
  });
}
