import { CheckIcon, ChevronDownIcon, GaugeIcon } from "lucide-react";
import { useState } from "react";
import { PromptInputButton } from "../components/ai-elements/prompt-input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { menuArrowKeys } from "../lib/menu-keys";

/* Engine effort ids are kept verbatim; only the label is friendlier. */
const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
export const effortLabel = (e: string) =>
  EFFORT_LABELS[e] ?? e.charAt(0).toUpperCase() + e.slice(1);

/* The effort dropdown (#886): a plain radio menu of exactly the levels the
   engine reported for the picked model — nothing invented, no slider. The
   caller draws it only for a model that reports levels. The button's
   accessible name carries the current level ("Reasoning effort: High"),
   and ↓ ↑ Home End walk the rows. */
export function EffortPicker({
  efforts,
  effort,
  onPick,
}: {
  efforts: string[];
  /** The level in force; undefined = the engine's own default. */
  effort: string | undefined;
  onPick: (effort: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = effort ? effortLabel(effort) : "Engine default";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <PromptInputButton
            size="sm"
            aria-label={`Reasoning effort: ${current}`}
            aria-haspopup="menu"
            title={`Reasoning effort · ${effort ? current : "engine default"}`}
            className="h-6 shrink-0 gap-1.5 rounded-md px-1.5 @max-[480px]:gap-0 @max-[480px]:px-1 font-normal text-[12.5px] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground aria-expanded:bg-[var(--v3-hover)] aria-expanded:text-foreground"
            data-slot="effort-picker-trigger"
          />
        }
      >
        <GaugeIcon className="size-3.5" />
        <span className="truncate @max-[480px]:hidden" data-effort>
          {current}
        </span>
        <ChevronDownIcon className="size-3 opacity-60 @max-[680px]:hidden" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-44 gap-0 p-0"
        aria-label="Reasoning effort"
      >
        <div
          role="menu"
          aria-label="Reasoning levels"
          className="py-1"
          onKeyDown={(e) => {
            menuArrowKeys(e);
          }}
        >
          {efforts.map((e) => (
            <button
              key={e}
              type="button"
              role="menuitemradio"
              aria-checked={e === effort}
              onClick={() => {
                onPick(e);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-foreground outline-none hover:bg-[var(--v3-hover)] focus-visible:bg-[var(--v3-hover)]"
            >
              <span className="grid w-3.5 shrink-0 place-items-center">
                {e === effort && <CheckIcon className="size-3.5" />}
              </span>
              {effortLabel(e)}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
