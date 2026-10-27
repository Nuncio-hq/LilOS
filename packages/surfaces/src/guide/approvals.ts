import { approvalAskSection } from "./approval-tools.js";

/**
 * Guide page: approvals (#340 AC-3).
 *
 * Which tools open an approval ask is rendered from `LILOS_TOOLS` (D-#36,
 * #783). A hand-written list named four tools and left out the schedule
 * writes.
 */
export const approvals = {
  title: "Approvals",
  body: `Anything that changes the company beyond a session's own thread —
opening threads, hiring, merging — goes through an ask Oscar answers. Reads
are always allowed; writes outside the thread are proposed, never pushed
through.

What Oscar sees:
- Ask cards inside the thread: a command approval in one plain sentence
  ("Edit README.md?") answered Allow / Deny — This thread and Always sit
  under Allow's ▾ — a plan review (Approve / Change / Reject), or a
  question waiting for free text.
- On the phone the same cards arrive as push-able notifications; answering
  either surface resolves the ask everywhere.
- A decided ask stays in the thread as a receipt ("Allowed once by Oscar",
  "You said no").

${approvalAskSection()}

Calling one posts the ask card and the call waits — Allow applies the
change and returns its result; Deny returns a declined error the agent
can read. Company changes always ask, even when the thread's access is Full.

The session reads its context with \`context\`, \`thread_read\` and
\`thread_list\`, and answers Oscar plainly via \`thread_post\`.`,
};
