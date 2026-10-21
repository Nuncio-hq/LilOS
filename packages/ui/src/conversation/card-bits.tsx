import type { ComponentProps } from "react";
import { cn } from "../lib/utils";

/* The v3 look the cards under a turn share (the prototype's AskCard + Btn):
   a hairline card, a quiet 13.5px muted header, 7px-radius buttons. Colour is
   only ever a status mark — a pill while the card waits, a check or cross on
   its receipt. */

/** A waiting card: hairline box, no tint. Overrides Alert's own box. */
export const CARD =
  "mt-1 w-full gap-2.5 rounded-[10px] border border-[var(--v3-line)] bg-transparent px-4 py-3.5 text-foreground";

/** A settled card: one quiet line, the box is gone. */
export const RECEIPT = "mt-1 border-0 bg-transparent p-0";

/** The header line of a card (also an AlertDescription's text styling). */
export const CARD_HEAD =
  "flex flex-wrap items-center gap-2 font-normal text-[13.5px] text-muted-foreground";

/** The ↵/⌫ shortcut line under a card. */
export const KEY_HINT = "text-[12px] text-muted-foreground/80";

const BTN =
  "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border px-3 font-medium text-[13px] transition-[background,transform] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50";

/** The prototype's Btn: ink-filled when primary, hairline otherwise. */
export function CardButton({
  primary,
  className,
  ...props
}: ComponentProps<"button"> & { primary?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        BTN,
        primary
          ? "border-foreground bg-foreground text-background hover:bg-foreground/85"
          : "border-foreground/15 bg-background text-foreground hover:bg-[var(--v3-hover)]",
        className,
      )}
      {...props}
    />
  );
}

/** A quiet text-only button (Not yet, Skip, Reject): no border. */
export function CardLink({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        BTN,
        "border-transparent px-2.5 text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}
