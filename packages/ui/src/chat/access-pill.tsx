import {
  ChevronDownIcon,
  ShieldAlertIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { PromptInputButton } from "../components/ai-elements/prompt-input";
import { cn } from "../lib/utils";
import type { ConversationAccess } from "../types";
import { useMenu } from "../v3/v3-keys";

/**
 * #106 — the composer's access pill, Codex-style: a neutral "Ask" reading
 * (the agent stops before risky commands) or an orange shield + "Full
 * access" (approvals auto-answer). One click toggles — no confirm dialog;
 * the switch applies to the agent's next action, mid-turn included.
 *
 * #884: when the engine's global policy reports `off` it auto-answers
 * everything — the pill goes orange, its click opens the warning (the
 * engine's policy is shared with terminal Hermes, so nothing writes it
 * without the user's click) and a one-click `Fix` that sets it to `smart`.
 */
export function AccessPill({
  access,
  onAccess,
  engineNeverAsks,
  engineName,
  onFixPolicy,
}: {
  access: ConversationAccess;
  onAccess: (a: ConversationAccess) => void;
  /** The engine reports `off`: the pill becomes the warning + the fix. */
  engineNeverAsks?: boolean;
  /** Its display name for the warning ("Hermes"). */
  engineName?: string;
  /** The Fix — sets the engine's policy to `smart` once, on click. */
  onFixPolicy?: () => void;
}) {
  const menu = useMenu();
  const full = access === "full";
  if (engineNeverAsks) {
    const name = engineName || "The engine";
    return (
      <span className="relative flex">
        <PromptInputButton
          ref={menu.trigger}
          size="sm"
          onClick={() => menu.setOpen((o) => !o)}
          aria-label={`${name} is set to never ask — open the warning`}
          aria-haspopup="menu"
          aria-expanded={menu.open}
          title={`${name} is set to never ask, so Ask won't stop risky commands.`}
          className={cn(
            "h-6 shrink gap-1.5 rounded-md px-1.5 font-normal text-[12.5px]",
            "text-orange-600 hover:bg-orange-500/10 hover:text-orange-600 dark:text-orange-400 dark:hover:bg-orange-500/15 dark:hover:text-orange-400",
          )}
          data-slot="access-pill"
          data-access={access}
          data-engine-never-asks
        >
          <ShieldAlertIcon className="size-3.5 fill-orange-500/20" />
          <span>Never asks</span>
          <ChevronDownIcon className="size-3 opacity-60" />
        </PromptInputButton>
        {menu.open && (
          <div
            ref={menu.list}
            role="menu"
            onKeyDown={menu.onKeyDown}
            className="absolute bottom-[calc(100%+6px)] left-0 z-20 w-72 rounded-lg border bg-popover p-3 shadow-lg"
          >
            <p className="text-[12.5px] text-foreground leading-normal">
              {name} is set to never ask, so Ask won't stop risky commands.
            </p>
            {onFixPolicy && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  menu.setOpen(false);
                  onFixPolicy();
                }}
                className="mt-2.5 w-full rounded-md bg-foreground px-2 py-1.5 text-[12.5px] font-medium text-background hover:opacity-90"
              >
                Fix — set {name} back to Smart
              </button>
            )}
          </div>
        )}
      </span>
    );
  }
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
        "h-6 shrink gap-1.5 rounded-md px-1.5 font-normal text-[12.5px] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground",
        /* The ghost variant's hover:text-foreground must not mute the
           warning: Full stays orange on hover too (Codex-style). */
        full &&
          "text-orange-600 hover:bg-orange-500/10 hover:text-orange-600 dark:text-orange-400 dark:hover:bg-orange-500/15 dark:hover:text-orange-400",
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
      {/* The only composer control without a menu affordance: the chevron
          reads "click to switch", matching the model picker beside it. */}
      <ChevronDownIcon className="size-3 opacity-60" />
    </PromptInputButton>
  );
}
