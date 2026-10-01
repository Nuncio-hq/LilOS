/**
 * Playwright globalTeardown (#347): after the last worker exits, sweep any
 * tagged stack whose owning worker is dead — the safety net under each
 * process's own orphan watchdog and each spec's afterAll teardown. Tags
 * whose owner pid is still alive belong to a sibling run; never touch them.
 */
import { sweepOrphanedLeakTags } from "./engine-leak";

export default async function globalTeardown(): Promise<void> {
  sweepOrphanedLeakTags();
}
