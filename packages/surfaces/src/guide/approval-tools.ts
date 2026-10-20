import { LILOS_TOOLS, type ToolArea } from "@lilos/contracts/harness";

/**
 * Approval-tool facts for `lilos_guide` pages (D-#36, #783).
 *
 * The gateway page already renders the whole catalog. The approvals page
 * listed `thread_start`, `team_hire`, `team_update` and `folder_add` by
 * hand, so the schedule writes (`schedule_create`, `schedule_update`,
 * `schedule_delete`, `schedule_run_now`) never appeared. The employees
 * page said the approval gate still shipped separately. Both pages take
 * the names from `LILOS_TOOLS` where `access === "approval"`.
 */
export function approvalToolNames(area?: ToolArea): string[] {
  return Object.entries(LILOS_TOOLS)
    .filter(
      ([, tool]) =>
        tool.access === "approval" &&
        (area === undefined || tool.area === area),
    )
    .map(([name]) => name);
}

/** `` `name` (opens an approval ask) `` — the marker the guide tests lock onto. */
function approvalAskMark(name: string): string {
  return `\`${name}\` (opens an approval ask)`;
}

/** Comma-separated marks, for a sentence. */
export function approvalAskMarks(area?: ToolArea): string {
  const names = approvalToolNames(area);
  if (names.length === 0) return "(none — no tool opens an approval ask)";
  return names.map(approvalAskMark).join(", ");
}

/**
 * One line per tool. Same phrase the gateway page uses.
 */
export function approvalAskLines(area?: ToolArea): string {
  const names = approvalToolNames(area);
  if (names.length === 0) return "- (none — no tool opens an approval ask)";
  return names.map((name) => `- ${approvalAskMark(name)}`).join("\n");
}

/** The catalog section both guide pages embed. */
export function approvalAskSection(): string {
  return [
    "Tools that open an approval ask — rendered from the catalog, every tool whose access is approval:",
    approvalAskLines(),
  ].join("\n");
}
