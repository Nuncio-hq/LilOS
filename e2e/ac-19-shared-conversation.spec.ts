import { expect, test } from "@playwright/test";

/* AC-5 (issue #19): the existing flows keep passing AND the seeded thread renders the same
   AgentTurn in the panel and in Focus — one component, steps collapsed into a single
   Task block (panel style). */
test("AC-5 thread panel and Focus render the same agent turn markup", async ({
  page,
}) => {
  await page.goto("/");
  // m1: "walk me through the envelope contract" — 4 replies (3 agent turns, one 6-step).
  await page.getByText("4 replies").first().click();
  const panel = page.locator("aside").last();
  await expect(panel.locator("[data-agentturn]")).toHaveCount(3);
  // Steps collapsed: one trigger shows "6 steps", no tool cards mounted open.
  const steps = panel.locator("[data-tasksteps]");
  await expect(steps).toHaveCount(2);
  await expect(steps.first()).toContainText("6 steps");
  // Same in Focus.
  await panel.getByRole("button", { name: "Focus" }).click();
  const focusTurns = page.locator("main [data-agentturn]");
  await expect(focusTurns).toHaveCount(3);
  const focusSteps = focusTurns.locator("[data-tasksteps]");
  await expect(focusSteps).toHaveCount(2);
  await expect(focusSteps.first()).toContainText("6 steps");
  // Expanding the block in Focus reveals the tool cards.
  await focusSteps.first().locator("button").first().click();
  await expect(focusSteps.first()).toContainText("write_file");
});
