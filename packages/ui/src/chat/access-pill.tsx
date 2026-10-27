import {
  CheckIcon,
  ChevronDownIcon,
  ShieldAlertIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useState } from "react";
import { PromptInputButton } from "../components/ai-elements/prompt-input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { cn } from "../lib/utils";
import type { ConversationAccess } from "../types";
import { FullAccessConfirm } from "./full-access-confirm";

/* #886 — the access pill opens a real menu instead of toggling: Ask and
   Full access, each with the one line that says what it means. Choosing
   Full asks — "Agents run tools without asking in this thread" — before
   it applies, every time and in every thread (a single click never
   switches, and a yes never carries over). The switch still applies to the
   agent's next action, mid-turn included.

   #884: when the engine's global policy reports `off` it auto-answers
   everything, so the same menu carries the warning + one-click Fix above
   the Ask/Full rows — one access control, not two (#886). The pill
   reads "Never asks" until the policy is repaired. */

export function AccessPill({
  access,
  onAccess,
  engineNeverAsks,
  engineName,
  onFixPolicy,
}: {
  access: ConversationAccess;
  onAccess: (a: ConversationAccess) => void;
  /** The engine reports `off` — the pill warns and the menu carries Fix. */
  engineNeverAsks?: boolean;
  /** Its display name for the warning ("Hermes"). */
  engineName?: string;
  /** The Fix — sets the engine's policy back to `smart` once, on click. */
  onFixPolicy?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const full = access === "full";
  const name = engineName || "The engine";
  const close = () => {
    /* A programmatic close does not fire onOpenChange — reset the view or
       the menu would reopen still asking. */
    setConfirming(false);
    setOpen(false);
  };
  const pick = (next: ConversationAccess) => {
    if (next === "full" && !full) {
      setConfirming(true);
      return;
    }
    onAccess(next);
    close();
  };
  const confirm = () => {
    onAccess("full");
    close();
  };
  const item =
    "flex w-full items-start gap-2 px-3 py-1.5 text-left outline-none hover:bg-[var(--v3-hover)] focus-visible:bg-[var(--v3-hover)]";
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setConfirming(false);
      }}
    >
      <PopoverTrigger
        render={
          <PromptInputButton
            size="sm"
            aria-label={
              engineNeverAsks
                ? `${name} is set to never ask — open the warning`
                : full
                  ? "Access: Full — the agent never stops to ask"
                  : "Access: Ask — the agent asks before risky commands"
            }
            aria-haspopup="menu"
            title={
              engineNeverAsks
                ? `${name} is set to never ask, so Ask won't stop risky commands.`
                : full
                  ? "Full access — the agent never stops to ask."
                  : "Ask — the agent asks before risky commands."
            }
            className={cn(
              "h-6 shrink gap-1.5 rounded-md px-1.5 font-normal text-[12.5px] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground aria-expanded:bg-[var(--v3-hover)] aria-expanded:text-foreground",
              /* Full and the engine warning stay orange on hover too
                 (Codex-style). */
              (full || engineNeverAsks) &&
                "text-orange-600 hover:bg-orange-500/10 hover:text-orange-600 dark:text-orange-400 dark:hover:bg-orange-500/15 dark:hover:text-orange-400",
            )}
            data-slot="access-pill"
            data-access={access}
            data-engine-never-asks={engineNeverAsks || undefined}
          />
        }
      >
        {full || engineNeverAsks ? (
          <ShieldAlertIcon className="size-3.5 fill-orange-500/20" />
        ) : (
          <ShieldQuestionIcon className="size-3.5" />
        )}
        {/* #886 narrow = icon + a short label, the same as the model and
            effort dropdowns beside it. */}
        <span className="@max-[480px]:hidden">
          {engineNeverAsks ? "Never asks" : full ? "Full access" : "Ask"}
        </span>
        <span className="hidden @max-[480px]:inline">
          {engineNeverAsks ? "Never" : full ? "Full" : "Ask"}
        </span>
        <ChevronDownIcon className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-[264px] gap-0 p-0"
        aria-label="Access"
      >
        {confirming ? (
          <FullAccessConfirm
            onBack={() => setConfirming(false)}
            onConfirm={confirm}
          >
            Agents run tools without asking in this thread
          </FullAccessConfirm>
        ) : (
          <div role="menu" aria-label="Access" className="py-1">
            {engineNeverAsks && (
              <div className="border-b px-3 pb-2.5 pt-2">
                <p className="text-[12.5px] leading-snug text-foreground">
                  {name} is set to never ask, so Ask won't stop risky commands.
                </p>
                {onFixPolicy && (
                  <button
                    type="button"
                    role="menuitem"
                    data-access-fix
                    onClick={() => {
                      onFixPolicy();
                      close();
                    }}
                    className="mt-2 w-full rounded-md bg-foreground px-2 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85"
                  >
                    Fix — set {name} back to Smart
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!full}
              data-access-option="ask"
              onClick={() => pick("ask")}
              className={item}
            >
              <ShieldQuestionIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px]">Ask</span>
                <span className="block text-[12px] leading-snug text-muted-foreground">
                  The agent asks before risky commands.
                </span>
              </span>
              {!full && <CheckIcon className="mt-0.5 size-3.5 shrink-0" />}
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={full}
              data-access-option="full"
              onClick={() => pick("full")}
              className={item}
            >
              <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0 fill-orange-500/20 text-orange-600 dark:text-orange-400" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px]">Full access</span>
                <span className="block text-[12px] leading-snug text-muted-foreground">
                  The agent never stops to ask.
                </span>
              </span>
              {full && <CheckIcon className="mt-0.5 size-3.5 shrink-0" />}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
