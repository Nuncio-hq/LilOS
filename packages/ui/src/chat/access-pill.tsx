import { ShieldAlertIcon, ShieldQuestionIcon } from "lucide-react";
import { PromptInputButton } from "../components/ai-elements/prompt-input";
import { cn } from "../lib/utils";
import type { ConversationAccess } from "../types";

/**
 * #106 — the composer's access pill, Codex-style: a neutral "Ask" reading
 * (the agent stops before risky commands) or an orange shield + "Full
 * access" (approvals auto-answer). One click toggles — no confirm dialog;
 * the switch applies to the agent's next action, mid-turn included.
 */
export function AccessPill({
  access,
  onAccess,
}: {
  access: ConversationAccess;
  onAccess: (a: ConversationAccess) => void;
}) {
  const full = access === "full";
  return (
    <PromptInputButton
      size="sm"
      onClick={() => onAccess(full ? "ask" : "full")}
      aria-label={
        full
          ? "Access: Full — the agent never stops to ask"
          : "Access: Ask — the agent asks before risky commands"
      }
      aria-pressed={full}
      title={
        full
          ? "Full access — the agent never stops to ask. Click to switch to Ask."
          : "Ask — the agent asks before risky commands. Click to switch to Full access."
      }
      className={cn(
        "shrink gap-1.5 text-foreground/80 text-xs",
        full && "text-orange-600 dark:text-orange-400",
      )}
      data-slot="access-pill"
      data-access={access}
    >
      {full ? (
        <>
          <ShieldAlertIcon className="size-3.5 fill-orange-500/20" />
          <span>Full access</span>
        </>
      ) : (
        <>
          <ShieldQuestionIcon className="size-3.5" />
          <span>Ask</span>
        </>
      )}
    </PromptInputButton>
  );
}
