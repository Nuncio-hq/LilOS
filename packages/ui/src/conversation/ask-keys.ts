import type { Reply } from "../types";
import type { PlanAction } from "./plan-card";

/* Issue #558: the newest waiting approval/plan card in the visible thread
   answers from the keyboard — ↵ allows once / approves, ⌫ denies / rejects
   (Esc is never an answer; #576 keeps it close-only). Keys act only on that
   one card and never while typing in the composer or on a control. */
export interface PendingAsk {
  kind: "approval" | "plan";
  reply: Reply;
}

/** The newest card still waiting on an answer, scanning back from the end —
 *  relays resolve one ask at a time, so the last open one owns the keys. */
export function pendingAsk(
  replies: Reply[],
  resolved: Record<string, string>,
  canPlan: boolean,
): PendingAsk | null {
  for (let i = replies.length - 1; i >= 0; i--) {
    const r = replies[i];
    if (r.approval && !resolved[r.approval.id])
      return { kind: "approval", reply: r };
    if (canPlan && r.plan?.status === "proposed")
      return { kind: "plan", reply: r };
  }
  return null;
}

/** What the hint line under a pending card shows — only the keys it offers. */
export function askHint(
  reply: Reply,
  kind: PendingAsk["kind"],
): string | null {
  if (kind === "plan") return "↵ Approve · ⌫ Reject";
  const options = reply.approval?.options?.length
    ? reply.approval.options
    : ["once", "always", "deny"];
  const parts: string[] = [];
  if (options.includes("once")) parts.push("↵ Allow once");
  if (options.includes("deny")) parts.push("⌫ Deny");
  return parts.length ? parts.join(" · ") : null;
}

/** True when the press lands on page chrome — not a field (typing) and not
 *  a control (Enter/Space there already does its own thing). */
function plainTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !target.closest(
    'input, textarea, select, [contenteditable], button, a[href], [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="option"], [role="menuitem"], [role="tab"], summary',
  );
}

export interface AskKeyContext {
  /** The card the keys would act on (from pendingAsk). */
  ask: PendingAsk | null;
  /** Viewer display name for the resolved label ("Allowed once by X"). */
  viewer: string;
  resolved: Record<string, string>;
  setResolved?: (r: Record<string, string>) => void;
  onPlan?: (a: PlanAction, planId: string) => void;
  /** A running turn + its stop handler — ⌘. is the stop shortcut (#576). */
  running: boolean;
  onStop?: () => void;
}

/** Key routing for a top-most conversation surface (thread panel / Focus).
 *  Returns true when the press was consumed. */
export function askKeyDown(e: KeyboardEvent, ctx: AskKeyContext): boolean {
  /* ⌘./Ctrl+. stops a running turn — the keyboard Stop (#576). Works even
     while typing, matching the ■ button the composer hides while typing. */
  if ((e.metaKey || e.ctrlKey) && (e.key === "." || e.code === "Period")) {
    if (ctx.running && ctx.onStop) {
      ctx.onStop();
      return true;
    }
    return false;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  if (e.key !== "Enter" && e.key !== "Backspace") return false;
  if (!plainTarget(e.target) || !ctx.ask) return false;
  const { reply } = ctx.ask;
  if (ctx.ask.kind === "plan") {
    if (!reply.plan || !ctx.onPlan) return false;
    ctx.onPlan(e.key === "Enter" ? "approve" : "reject", reply.plan.id);
    return true;
  }
  const approval = reply.approval;
  if (!approval || !ctx.setResolved) return false;
  const options = approval.options?.length
    ? approval.options
    : ["once", "always", "deny"];
  /* The keyboard only ever writes the same labels the buttons do, so the
     resolved-diff → respondToRequest path in the app layer stays the single
     way an answer reaches the relay. */
  if (e.key === "Enter" && options.includes("once")) {
    ctx.setResolved({
      ...ctx.resolved,
      [approval.id]: `Allowed once by ${ctx.viewer}`,
    });
    return true;
  }
  if (e.key === "Backspace" && options.includes("deny")) {
    ctx.setResolved({
      ...ctx.resolved,
      [approval.id]: `Denied by ${ctx.viewer}`,
    });
    return true;
  }
  return false;
}
