import {
  CheckIcon,
  ChevronDownIcon,
  ShieldAlertIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { createPortal } from "react-dom";
import { PromptInputButton } from "../components/ai-elements/prompt-input";
import { cn } from "../lib/utils";
import type { ConversationAccess } from "../types";
import { useMenu } from "../v3/v3-keys";

/**
 * #106 — the composer's access control, Codex-style: a shield icon that
 * opens a plain dropdown of the levels the engine reports (D-#868), each
 * with a one-line hint — never a toggle you have to guess. The pick applies
 * to the agent's next action, mid-turn included.
 *
 * Built on the v3 useMenu (ChipMenu's pattern), not base-ui's DropdownMenu —
 * that pair raced Playwright's actionability checks and hung ac-106. But the
 * PromptInput box is `overflow-hidden`, so the menu still goes through a
 * portal: in-flow `absolute` gets clipped above the rounded box, and
 * `fixed` without a portal resolves against the composer's `@container`
 * (layout containment), not the viewport.
 */
const OPTIONS: {
  id: ConversationAccess;
  label: string;
  hint: string;
  Icon: typeof ShieldQuestionIcon;
}[] = [
  {
    id: "ask",
    label: "Ask",
    hint: "The agent stops before risky commands.",
    Icon: ShieldQuestionIcon,
  },
  {
    id: "full",
    label: "Full access",
    hint: "The agent never stops to ask.",
    Icon: ShieldAlertIcon,
  },
];

export function AccessPill({
  access,
  onAccess,
}: {
  access: ConversationAccess;
  onAccess: (a: ConversationAccess) => void;
}) {
  const full = access === "full";
  const cur = OPTIONS.find((o) => o.id === access) ?? OPTIONS[0];
  const { open, setOpen, trigger, list, close, onKeyDown } = useMenu();
  /* Anchored to the trigger's rect at open time: the menu is short-lived and
     any outside press (scroll away included) closes it. */
  const at = open ? trigger.current?.getBoundingClientRect() : undefined;
  return (
    <span className="relative shrink-0">
      <PromptInputButton
        ref={trigger}
        size="sm"
        aria-label={`Access: ${cur.label} — ${cur.hint}`}
        title={`Access: ${cur.label} — ${cur.hint}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "h-6 shrink gap-1 rounded-md px-1.5 font-normal text-[12.5px] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground",
          /* The ghost variant's hover:text-foreground must not mute the
             warning: Full stays orange on hover too (Codex-style). */
          full &&
            "text-orange-600 hover:bg-orange-500/10 hover:text-orange-600 dark:text-orange-400 dark:hover:bg-orange-500/15 dark:hover:text-orange-400",
        )}
        data-slot="access-pill"
        data-access={access}
      >
        <cur.Icon className={cn("size-3.5", full && "fill-orange-500/20")} />
        <span className="sr-only">{cur.label}</span>
        <ChevronDownIcon className="size-3 opacity-60" />
      </PromptInputButton>
      {open &&
        at &&
        createPortal(
          <div
            ref={list}
            role="menu"
            aria-label="Access"
            tabIndex={-1}
            onKeyDown={onKeyDown}
            style={{
              position: "fixed",
              left: at.left,
              bottom: window.innerHeight - at.top + 4,
            }}
            className="z-50 w-64 rounded-lg border border-[var(--v3-line)] bg-popover p-1 shadow-lg"
          >
            {OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                role="menuitemradio"
                aria-checked={o.id === access}
                onClick={() => {
                  onAccess(o.id);
                  close();
                }}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none hover:bg-[var(--v3-hover)] focus-visible:bg-[var(--v3-hover)]"
              >
                <o.Icon
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    o.id === "full" && "text-orange-500",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block">{o.label}</span>
                  <span className="block text-muted-foreground text-xs">
                    {o.hint}
                  </span>
                </span>
                {o.id === access && (
                  <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}
