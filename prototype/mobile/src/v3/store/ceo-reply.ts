import { agentNameOf, type V3Data, type V3Reply } from "@lilos/ui/v3-data";
import { v3Draft } from "../../../../web/src/fake-v3";

/** The CEO answers its own chat in character: a question is answered from the
    live company (the same words ⌘K gives on the Mac), anything else comes back
    as the plan the CEO would follow, in plain prose. No tickets are opened. */
export function ceoReply(text: string, d: V3Data): V3Reply {
  const draft = v3Draft(text, d);
  if (draft.kind === "answer") {
    const open = d.tickets.filter((t) => t.status !== "done").length;
    return {
      steps: [
        {
          kind: "read",
          target: "Tickets and threads",
          meta: `${open} open tickets`,
        },
      ],
      answer: draft.text,
    };
  }
  const list = draft.tickets
    .map((t) => `${t.title} (${agentNameOf(d, t.owner)}, ${t.est})`)
    .join("; ");
  return {
    steps: [
      {
        kind: "search",
        target: "Goals and open tickets",
        meta: `${d.goals.length} goals`,
      },
      {
        kind: "think",
        target:
          "Give every ticket one owner and have Reviewer check the result.",
      },
    ],
    answer: `${draft.lead} ${list}. About ${draft.hours} hours and $${draft.cost} in all. Nothing starts until you say so.`,
  };
}
