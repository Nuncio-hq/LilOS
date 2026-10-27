import { useState } from "react";
import { FullAccessConfirm } from "../chat/full-access-confirm";
import type { ConversationAccess } from "../types";
import { Segmented } from "./v3-settings-bits";

/* Settings' default access for new conversations (#886). Picking Full asks
   first, the same confirm the access pill shows, with the copy for what a
   default does: a cancelled confirm leaves Ask, and nothing is saved until
   the yes. */

const OPTIONS: { id: ConversationAccess; label: string }[] = [
  { id: "ask", label: "Ask before risky commands" },
  { id: "full", label: "Full access" },
];

export function DefaultAccess({
  value,
  onChange,
}: {
  value: ConversationAccess;
  onChange: (a: ConversationAccess) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Segmented
        label="Approvals"
        value={value}
        options={OPTIONS}
        onChange={(id) => {
          if (id === "full" && value !== "full") setConfirming(true);
          else {
            setConfirming(false);
            onChange(id);
          }
        }}
      />
      {confirming && (
        <div className="mt-3 w-fit max-w-full rounded-lg border border-[var(--v3-line)]">
          <FullAccessConfirm
            onBack={() => setConfirming(false)}
            onConfirm={() => {
              setConfirming(false);
              onChange("full");
            }}
          >
            New conversations will run tools without asking
          </FullAccessConfirm>
        </div>
      )}
    </>
  );
}
