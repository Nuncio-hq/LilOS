import type { ReactNode } from "react";

/* The one confirm in front of Full access (#886): the access pill's menu
   and Settings' default both ask it, every time — a yes never carries over
   to another thread, so the copy says what THIS grant does. */
export function FullAccessConfirm({
  children,
  onBack,
  onConfirm,
}: {
  /** What Full access does here ("Agents run tools without asking in this
      thread"). */
  children: ReactNode;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      data-full-access-confirm
      className="flex flex-col gap-2.5 px-3 py-3"
      role="group"
      aria-label="Confirm Full access"
    >
      <p className="text-[12.5px] leading-snug text-foreground">{children}</p>
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onBack}
          className="h-6 rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground"
        >
          Back
        </button>
        <button
          type="button"
          data-access-confirm
          onClick={onConfirm}
          className="h-6 rounded-md bg-foreground px-2 text-[12.5px] font-medium text-background hover:bg-foreground/85"
        >
          Use Full access
        </button>
      </div>
    </div>
  );
}
