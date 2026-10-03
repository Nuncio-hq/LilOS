/**
 * Guide page: approvals (#340 AC-3).
 */
export const approvals = {
  title: "Approvals",
  body: `Anything that changes the company beyond a session's own thread —
opening threads, hiring, merging — goes through an ask Oscar answers. Reads
are always allowed; writes outside the thread are proposed, never pushed
through.

What Oscar sees:
- Ask cards inside the thread: a command approval (Approve once / Always /
  Reject), a plan review (Approve / Change / Reject), or a question waiting
  for free text.
- On the phone the same cards arrive as push-able notifications; answering
  either surface resolves the ask everywhere.
- A decided ask stays in the thread as a receipt ("Approved once by Oscar").

Tools that apply:
- Approval-gated write tools land with the gateway's approval gate (slice D,
  issue #341) — they are not part of this toolset yet.
- Today the session reads its context with \`context\`, \`thread_read\` and
  \`thread_list\`, and can still answer Oscar plainly via \`thread_post\`.`,
};
