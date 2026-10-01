import type { GuideTopic } from "@lilos/contracts/harness";
import { approvals } from "./approvals.js";
import { dmAndThreads } from "./dm-and-threads.js";
import { employees } from "./employees.js";
import { gateway } from "./gateway.js";
import { mobile } from "./mobile.js";
import { overview } from "./overview.js";
import { workbench } from "./workbench.js";

/**
 * The LilOS guide pages `lilos_guide` serves (#340 AC-3): they live next to
 * the gateway, ship inside the app bundle, and each one says what Oscar
 * sees plus which tools apply. `GUIDE_TOPICS` in the contract is the
 * authoritative list — every topic resolves to a page here.
 */
export const GUIDES: Record<GuideTopic, { title: string; body: string }> = {
  overview,
  "dm-and-threads": dmAndThreads,
  employees,
  approvals,
  workbench,
  mobile,
  gateway,
};

/** The no-topic answer: the topic index with one line each. */
export function guideIndex(): string {
  const rows = Object.entries(GUIDES).map(
    ([topic, g]) => `- ${topic}: ${g.title}`,
  );
  return [
    "LilOS guide — call `guide` with a topic for the full page.",
    "",
    ...rows,
  ].join("\n");
}
