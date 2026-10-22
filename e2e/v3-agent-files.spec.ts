import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * #762 prototype: an agent's instructions, notes and skills, and the company
 * skill library. Mock company. Shots land in test-results/762-proto.
 */

const OUT = "test-results/762-proto";

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true });
});

const shot = async (page: Page, theme: string, name: string) => {
  await page.screenshot({ path: `${OUT}/${theme}-${name}.png` });
};

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: instructions, notes, skills, and the library`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?page=people&open=agent:scout&full=1&theme=${theme}`);
    await expect(
      page.locator(theme === "dark" ? "html.dark" : "html:not(.dark)"),
    ).toBeAttached();
    const peek = page.locator('aside[aria-label="Opened record"]');
    await expect(peek.getByRole("heading", { level: 1 })).toHaveText("Scout");

    await peek.getByRole("button", { name: "Edit" }).click();
    const instructions = peek.getByLabel("Instructions");
    await expect(instructions).toBeVisible();
    await instructions.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shot(page, theme, "instructions");
    await peek.getByRole("button", { name: "Cancel" }).click();
    await expect(instructions).toHaveCount(0);

    const notes = peek.locator("[data-agent-notes]");
    await notes.scrollIntoViewIfNeeded();
    await expect(
      notes.getByRole("button", { name: /readers\.md/ }),
    ).toBeVisible();
    await expect(
      notes.getByRole("button", { name: /creators\.md/ }),
    ).toBeVisible();
    await shot(page, theme, "notes-list");

    await notes.getByRole("button", { name: /readers\.md/ }).click();
    await notes.getByRole("button", { name: "Edit" }).click();
    const body = notes.getByLabel("Note");
    await expect(body).toBeVisible();
    await body.fill(
      "HeardBack readers journal at night.\nEdited in the prototype.",
    );
    await body.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shot(page, theme, "note-edit");
    await notes.getByRole("button", { name: "Save" }).click();
    await expect(notes.getByText("Edited in the prototype.")).toBeVisible();

    const skills = peek.locator("[data-agent-skills]");
    await skills.scrollIntoViewIfNeeded();
    const research = skills.getByRole("button", {
      name: "web-research",
      exact: true,
    });
    await expect(research).toHaveAttribute("aria-pressed", "true");
    await research.click();
    await expect(research).toHaveAttribute("aria-pressed", "false");
    await research.click();
    await expect(research).toHaveAttribute("aria-pressed", "true");
    const voice = skills.getByRole("button", {
      name: "brand-voice",
      exact: true,
    });
    await expect(voice).toHaveAttribute("aria-pressed", "false");
    await skills.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shot(page, theme, "skills");

    await skills.getByRole("button", { name: "Library" }).click();
    await expect(page).toHaveURL(/page=settings&view=skills/);
    const main = page.locator("#v3-main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(
      "Settings",
    );
    await expect(
      main.getByRole("button", { name: "Skills", exact: true }),
    ).toBeVisible();
    await expect(main.getByText("Choose a skill.")).toBeVisible();
    await shot(page, theme, "skills-list");

    await main.getByRole("button", { name: /web-research/ }).click();
    await expect(main.locator("[data-skill-view]")).toContainText(
      "Cite every row.",
    );
    await shot(page, theme, "skill-view");

    await main.getByRole("button", { name: "Add skill" }).click();
    await main.locator('input[type="file"]').setInputFiles({
      name: "launch-notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Launch\nAsk before anything goes public.\n"),
    });
    await expect(main.getByLabel("Name")).toHaveValue("launch notes");
    await expect(main.getByLabel("Skill text")).toHaveValue(
      "# Launch\nAsk before anything goes public.\n",
    );
    await main.locator("[data-add-skill]").scrollIntoViewIfNeeded();
    await shot(page, theme, "add-skill");
    await main.getByRole("button", { name: "Add", exact: true }).click();
    await expect(main.locator("[data-skill-view]")).toContainText(
      "Ask before anything goes public.",
    );
    await expect(
      main.getByRole("button", { name: /launch notes/ }),
    ).toBeVisible();
  });
}
