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

/* #886 — the access pill opens a real menu instead of toggling: Ask and
   Full access, each with the one line that says what it means. Choosing
   Full asks once — "Agents run tools without asking in this thread" —
   before it applies (a single click never switches); the yes is remembered
   in localStorage, so later picks go straight through. The switch still
   applies to the agent's next action, mid-turn included. */

/** localStorage flag: the user already confirmed what Full access does. */
const FULL_OK = "lilos-full-access-ok";

const fullOk = () => {
  try {
    return localStorage.getItem(FULL_OK) === "1";
  } catch {
    return false;
  }
};

export function AccessPill({
  access,
  onAccess,
}: {
  access: ConversationAccess;
  onAccess: (a: ConversationAccess) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const full = access === "full";
  const close = () => {
    /* A programmatic close does not fire onOpenChange — reset the view or
       the menu would reopen still asking. */
    setConfirming(false);
    setOpen(false);
  };
  const pick = (next: ConversationAccess) => {
    if (next === "full" && !full && !fullOk()) {
      setConfirming(true);
      return;
    }
    onAccess(next);
    close();
  };
  const confirm = () => {
    try {
      localStorage.setItem(FULL_OK, "1");
    } catch {
      /* Private windows can refuse the write — the confirm still shows
         next time, which is the safe side. */
    }
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
              full
                ? "Access: Full — the agent never stops to ask"
                : "Access: Ask — the agent asks before risky commands"
            }
            aria-haspopup="menu"
            title={
              full
                ? "Full access — the agent never stops to ask."
                : "Ask — the agent asks before risky commands."
            }
            className={cn(
              "h-6 shrink gap-1.5 rounded-md px-1.5 font-normal text-[12.5px] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground aria-expanded:bg-[var(--v3-hover)] aria-expanded:text-foreground",
              /* Full stays orange on hover too (Codex-style). */
              full &&
                "text-orange-600 hover:bg-orange-500/10 hover:text-orange-600 dark:text-orange-400 dark:hover:bg-orange-500/15 dark:hover:text-orange-400",
            )}
            data-slot="access-pill"
            data-access={access}
          />
        }
      >
        {full ? (
          <ShieldAlertIcon className="size-3.5 fill-orange-500/20" />
        ) : (
          <ShieldQuestionIcon className="size-3.5" />
        )}
        {/* The label steps aside for the icon alone in a narrow box (#886). */}
        <span className="@max-[480px]:hidden">
          {full ? "Full access" : "Ask"}
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
          <div className="flex flex-col gap-2.5 px-3 py-3">
            <p className="text-[12.5px] leading-snug text-foreground">
              Agents run tools without asking in this thread
            </p>
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="h-6 rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground"
              >
                Back
              </button>
              <button
                type="button"
                data-access-confirm
                onClick={confirm}
                className="h-6 rounded-md bg-foreground px-2 text-[12.5px] font-medium text-background hover:bg-foreground/85"
              >
                Use Full access
              </button>
            </div>
          </div>
        ) : (
          <div role="menu" aria-label="Access" className="py-1">
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
