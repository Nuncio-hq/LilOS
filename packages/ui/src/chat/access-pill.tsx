import {
  ChevronDownIcon,
  ShieldAlertIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { PromptInputButton } from "../components/ai-elements/prompt-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { cn } from "../lib/utils";
import type { ConversationAccess } from "../types";

/**
 * #106 — the composer's access control, Codex-style: a shield icon that
 * opens a plain dropdown of the levels the engine reports (D-#868), each
 * with a one-line hint — never a toggle you have to guess. The pick applies
 * to the agent's next action, mid-turn included.
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <PromptInputButton
            size="sm"
            aria-label={`Access: ${cur.label} — ${cur.hint}`}
            title={`Access: ${cur.label} — ${cur.hint}`}
            className={cn(
              "h-6 shrink gap-1 rounded-md px-1.5 font-normal text-[12.5px] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground",
              /* The ghost variant's hover:text-foreground must not mute the
                 warning: Full stays orange on hover too (Codex-style). */
              full &&
                "text-orange-600 hover:bg-orange-500/10 hover:text-orange-600 dark:text-orange-400 dark:hover:bg-orange-500/15 dark:hover:text-orange-400",
            )}
            data-slot="access-pill"
            data-access={access}
          />
        }
      >
        <cur.Icon className={cn("size-3.5", full && "fill-orange-500/20")} />
        <span className="sr-only">{cur.label}</span>
        <ChevronDownIcon className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-64"
        aria-label="Access"
      >
        <DropdownMenuRadioGroup
          value={access}
          onValueChange={(v) => onAccess(v as ConversationAccess)}
        >
          {OPTIONS.map((o) => (
            <DropdownMenuRadioItem
              key={o.id}
              value={o.id}
              className="items-start py-1.5"
            >
              <o.Icon
                className={cn(
                  "mt-0.5 size-3.5",
                  o.id === "full" && "text-orange-500",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block">{o.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {o.hint}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
