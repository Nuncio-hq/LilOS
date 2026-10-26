import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  MoonStarIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  SunriseIcon,
  TimerResetIcon,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/utils";
import { Btn } from "./v3-bits";
import { EscLayer, useMenu } from "./v3-keys";

/* A thread's quiet ⋯ menu and its inline title editor: pin, settle, snooze
   and rename — the T3 Code thread menu's shape (#862). The menu draws only
   the items the app can do (`act.pinThread` and friends); with none there
   is no menu at all. Snooze and Auto-settle drill into their own pane
   inside the same menu, so the whole thing still works at phone width.
   Every row on Threads and the thread's own header use the same pair. */

const ITEM =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground outline-none hover:bg-[var(--v3-hover)] focus-visible:bg-[var(--v3-hover)] [&_svg]:size-3.5 [&_svg]:text-muted-foreground";

/** The pin / snooze / settle choices a thread's menu offers; each is drawn
    only with the handler that backs it. `snoozedUntil` set means the thread
    is asleep now: the menu leads with Wake now instead of Snooze. */
export type ThreadPark = {
  pinned?: boolean;
  onPin?: (pinned: boolean) => void;
  /** The wake time while the thread is actually snoozed, epoch ms. */
  snoozedUntil?: number;
  /** Sleep until then, epoch ms — the thread keeps working underneath. */
  onSnooze?: (until: number) => void;
  /** Ends the snooze now. */
  onWake?: () => void;
  /** Auto-settle's state on this thread; `onAutoSettle` flips it. */
  autoSettle?: boolean;
  onAutoSettle?: (enabled: boolean) => void;
};

type MenuView = "main" | "snooze" | "auto" | "custom";

const HHMM = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The snooze presets, built against right now: an hour out, tonight at
    18:00 (only while that is over an hour away), tomorrow at 09:00 — the
    same set T3 Code's sidebar offers. */
function snoozePresets(now: number): { label: string; at: number }[] {
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  const morning = new Date(now + 86_400_000);
  morning.setHours(9, 0, 0, 0);
  return [
    { label: "1 h", at: now + 3_600_000 },
    ...(evening.getTime() - now > 3_600_000
      ? [{ label: "Tonight", at: evening.getTime() }]
      : []),
    { label: "Tomorrow morning", at: morning.getTime() },
  ];
}

function Divider() {
  return <div className="my-1 border-[var(--v3-line)] border-t" />;
}

/** A drill pane's head: back to the main menu, then what the pane is. */
function DrillHead({ title, back }: { title: string; back: () => void }) {
  return (
    <>
      <button type="button" onClick={back} className={cn(ITEM, "font-medium")}>
        <ChevronLeftIcon />
        {title}
      </button>
      <Divider />
    </>
  );
}

/** "In a while" vs "at a time": the custom snooze's two ways to pick a
    wake, kept inside the menu so it never overflows a narrow pane. */
function CustomSnooze({
  onPick,
  back,
}: {
  onPick: (until: number) => void;
  back: () => void;
}) {
  const twoHours = Date.now() + 2 * 3_600_000;
  const [mode, setMode] = useState<"after" | "at">("after");
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState(3_600_000);
  const [day, setDay] = useState(() => {
    const d = new Date(twoHours);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [time, setTime] = useState(() => HHMM(twoHours));

  const until = (): number | undefined => {
    if (mode === "after") {
      const n = Number(amount);
      return n > 0 ? Date.now() + n * unit : undefined;
    }
    const t = new Date(`${day}T${time}`).getTime();
    return Number.isFinite(t) && t > Date.now() ? t : undefined;
  };

  return (
    <>
      <DrillHead title="Custom" back={back} />
      {/* Arrows belong to the inputs here; the menu's ↑↓ would steal them. */}
      <div
        className="px-3 py-2"
        onKeyDown={(e) => {
          if (e.key.startsWith("Arrow")) e.stopPropagation();
        }}
      >
        <div className="flex gap-1.5" role="radiogroup" aria-label="Snooze for">
          {(
            [
              ["after", "In a while"],
              ["at", "At a time"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "h-7 flex-1 rounded-md border text-[12.5px]",
                mode === m
                  ? "border-foreground/40 bg-[var(--v3-hover)] font-medium text-foreground"
                  : "border-[var(--v3-line)] text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "after" ? (
          <div className="mt-2.5 flex gap-1.5">
            <input
              type="number"
              min={1}
              aria-label="Amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-7 w-16 rounded-md border border-[var(--v3-line)] bg-background px-2 text-[13px] text-foreground outline-none focus:border-foreground/40"
            />
            <select
              aria-label="Unit"
              value={unit}
              onChange={(e) => setUnit(Number(e.target.value))}
              className="h-7 flex-1 rounded-md border border-[var(--v3-line)] bg-background px-1.5 text-[13px] text-foreground outline-none focus:border-foreground/40"
            >
              <option value={60_000}>minutes</option>
              <option value={3_600_000}>hours</option>
              <option value={86_400_000}>days</option>
            </select>
          </div>
        ) : (
          <div className="mt-2.5 flex gap-1.5">
            <input
              type="date"
              aria-label="Date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className="h-7 min-w-0 flex-1 rounded-md border border-[var(--v3-line)] bg-background px-1.5 text-[13px] text-foreground outline-none focus:border-foreground/40"
            />
            <input
              type="time"
              aria-label="Time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="h-7 w-[88px] rounded-md border border-[var(--v3-line)] bg-background px-1.5 text-[13px] text-foreground outline-none focus:border-foreground/40"
            />
          </div>
        )}
        <div className="mt-2.5 flex justify-end">
          <Btn
            primary
            small
            disabled={until() === undefined}
            onClick={() => {
              const t = until();
              if (t !== undefined) onPick(t);
            }}
          >
            Snooze
          </Btn>
        </div>
      </div>
    </>
  );
}

/** The ⋯ button and its menu. Rows are clickable, so every click and key in
    here stays here (a menu item must not also open the thread). */
export function ThreadMenu({
  archived,
  onRename,
  onArchive,
  park,
  quiet,
  className,
  triggerRef,
}: {
  /** On the Settled shelf: Settle reads Un-settle, and Pin/Snooze stay off
      (a parked thread comes back through Un-settle). */
  archived?: boolean;
  onRename?: () => void;
  onArchive?: () => void;
  park?: ThreadPark;
  /** For a caller that puts the keyboard back on the ⋯ button itself (after
      renaming in place). */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  /** In a list row: drawn only while the row is hovered or focused (the
      row is `group/thread`). Off, as in a thread's own header, it always shows. */
  quiet?: boolean;
  className?: string;
}) {
  const { open, setOpen, trigger, list, onKeyDown } = useMenu(triggerRef);
  const [view, setView] = useState<MenuView>("main");
  // Opening, and each drill down, puts the keyboard on the pane's head.
  useEffect(() => {
    if (open) list.current?.querySelector("button")?.focus();
  }, [open, view, list]);
  const asleep = !archived && park?.snoozedUntil !== undefined;
  /* On the shelf only Un-settle and Auto-settle still apply — the flag
     rides along, so a settled thread stays settled until you say so. */
  const hasPark =
    (!archived &&
      (park?.onPin || park?.onSnooze || (asleep && park?.onWake))) ||
    park?.onAutoSettle !== undefined;
  if (!onRename && !onArchive && !hasPark) return null;

  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  const toggle = () =>
    setOpen((o) => {
      if (!o) setView("main");
      return !o;
    });
  const back = () => setView("main");
  const parkActions = park;

  return (
    <span
      className={cn("relative shrink-0", className)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        ref={trigger}
        type="button"
        aria-label="Thread actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className={cn(
          "grid size-6 place-items-center rounded-md text-muted-foreground outline-none transition-opacity hover:bg-[var(--v3-hover)] hover:text-foreground",
          quiet &&
            "opacity-0 focus-visible:opacity-100 group-focus-within/thread:opacity-100 group-hover/thread:opacity-100 [@media(hover:none)]:opacity-100",
          open && "bg-[var(--v3-hover)] opacity-100",
        )}
      >
        <EllipsisIcon className="size-4" />
      </button>
      {open && (
        <div
          ref={list}
          role="menu"
          aria-label="Thread actions"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="absolute top-full right-0 z-20 mt-1 min-w-[208px] rounded-lg border border-[var(--v3-line)] bg-background py-1 text-[13.5px]"
        >
          {view === "main" && (
            <>
              {!archived && parkActions?.onPin && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={pick(() => parkActions.onPin?.(!parkActions.pinned))}
                  className={ITEM}
                >
                  {parkActions.pinned ? <PinOffIcon /> : <PinIcon />}
                  {parkActions.pinned ? "Unpin thread" : "Pin thread"}
                </button>
              )}
              {onArchive && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={pick(onArchive)}
                  className={ITEM}
                >
                  {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                  {archived ? "Un-settle thread" : "Settle thread"}
                </button>
              )}
              {!archived &&
                (asleep && parkActions?.onWake ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={pick(parkActions.onWake)}
                    className={ITEM}
                  >
                    <SunriseIcon />
                    Wake now
                  </button>
                ) : (
                  parkActions?.onSnooze && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => setView("snooze")}
                      className={ITEM}
                    >
                      <MoonStarIcon />
                      <span className="flex-1">Snooze</span>
                      <ChevronRightIcon />
                    </button>
                  )
                ))}
              <Divider />
              {onRename && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={pick(onRename)}
                  className={ITEM}
                >
                  <PencilIcon />
                  Rename thread
                </button>
              )}
              {parkActions?.onAutoSettle && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setView("auto")}
                  className={ITEM}
                >
                  <TimerResetIcon />
                  <span className="flex-1">Auto-settle</span>
                  <ChevronRightIcon />
                </button>
              )}
            </>
          )}
          {view === "snooze" && parkActions?.onSnooze && (
            <>
              <DrillHead title="Snooze until" back={back} />
              {snoozePresets(Date.now()).map((p) => (
                <button
                  key={p.label}
                  type="button"
                  role="menuitem"
                  onClick={pick(() => parkActions.onSnooze?.(p.at))}
                  className={ITEM}
                >
                  <span className="flex-1">{p.label}</span>
                  <span className="text-[12.5px] text-muted-foreground">
                    {HHMM(p.at)}
                  </span>
                </button>
              ))}
              <Divider />
              <button
                type="button"
                role="menuitem"
                onClick={() => setView("custom")}
                className={ITEM}
              >
                Custom…
              </button>
            </>
          )}
          {view === "custom" && parkActions?.onSnooze && (
            <CustomSnooze
              back={() => setView("snooze")}
              onPick={(t) => {
                setOpen(false);
                parkActions.onSnooze?.(t);
              }}
            />
          )}
          {view === "auto" && parkActions?.onAutoSettle && (
            <>
              <DrillHead title="Auto-settle" back={back} />
              {(
                [
                  [true, "Enabled"],
                  [false, "Disabled"],
                ] as const
              ).map(([on, label]) => {
                const checked = (parkActions.autoSettle !== false) === on;
                return (
                  <button
                    key={label}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    onClick={pick(() => parkActions.onAutoSettle?.(on))}
                    className={ITEM}
                  >
                    <span className="w-3.5">
                      {checked && <CheckIcon className="text-foreground" />}
                    </span>
                    {label}
                  </button>
                );
              })}
              <p className="px-3 py-2 text-[12px] leading-snug text-muted-foreground">
                A thread settles itself after 3 days idle, or when its PR merges
                or closes. Disabled, it stays where you put it.
              </p>
            </>
          )}
        </div>
      )}
    </span>
  );
}

/** The title being renamed. Enter or leaving the box saves; Esc keeps the old
    title. An empty or unchanged title is not a rename. `onDone(byKey)` says
    whether the keyboard ended it (Enter, Esc): then focus should come back to
    where the rename began; after a click elsewhere it stays where you clicked. */
export function TitleInput({
  value,
  onSave,
  onDone,
  className,
  ariaLabel = "Thread title",
}: {
  value: string;
  onSave: (title: string) => void;
  onDone: (byKey: boolean) => void;
  className?: string;
  /** What the box is called when it is not a thread's (an agent's name). */
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(value);
  // Leaving the box also fires blur once Enter or Esc has already decided.
  const decided = useRef(false);
  const finish = (save: boolean, byKey = true) => {
    if (decided.current) return;
    decided.current = true;
    const next = draft.trim();
    if (save && next && next !== value) onSave(next);
    onDone(byKey);
  };
  return (
    <>
      {/* Esc through the layer stack, like every other panel: a view behind
          this box (the widened thread) must not take the key first and close,
          which would also unmount the box and save what Esc cancels. */}
      <EscLayer onEscape={() => finish(false)} />
      <input
        // biome-ignore lint/a11y/noAutofocus: it opens because you asked to rename
        autoFocus
        aria-label={ariaLabel}
        value={draft}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key !== "Enter") return;
          // Focus returns to the ⋯ button as the box closes; this Enter must
          // not also click it and open the menu.
          e.preventDefault();
          finish(true);
        }}
        onBlur={() => finish(true, false)}
        className={cn(
          "h-7 min-w-0 flex-1 rounded-[7px] border border-foreground/25 bg-background px-2 text-foreground outline-none [font-family:inherit] [font-size:inherit] [font-weight:inherit] focus:border-foreground/45",
          className,
        )}
      />
    </>
  );
}

/** Rename state plus the menu for one thread, wherever its title shows (a
    list row, a thread's header). `input` replaces the title while it is being
    renamed and is undefined otherwise (draw the title yourself then); `menu`
    is undefined when the app can do none of the actions. */
export function useRenameMenu({
  title,
  archived = false,
  quiet = false,
  inputClassName,
  onRename,
  onArchive,
  park,
}: {
  title: string;
  archived?: boolean;
  quiet?: boolean;
  /** Sizes the input to the title it replaces. */
  inputClassName?: string;
  onRename?: (title: string) => void;
  onArchive?: (archived: boolean) => void;
  park?: ThreadPark;
}): { input: ReactNode | undefined; menu: ReactNode | undefined } {
  const [editing, setEditing] = useState(false);
  // Renaming comes from the ⋯ menu: finishing by key puts the keyboard back on
  // its button, as closing the menu would.
  const trigger = useRef<HTMLButtonElement>(null);
  const input =
    editing && onRename ? (
      <TitleInput
        value={title}
        onSave={onRename}
        onDone={(byKey) => {
          setEditing(false);
          if (byKey) trigger.current?.focus();
        }}
        className={inputClassName}
      />
    ) : undefined;
  const menu =
    onRename || onArchive || park ? (
      <ThreadMenu
        triggerRef={trigger}
        quiet={quiet}
        archived={archived}
        onRename={onRename ? () => setEditing(true) : undefined}
        onArchive={onArchive ? () => onArchive(!archived) : undefined}
        park={park}
      />
    ) : undefined;
  return { input, menu };
}
