/**
 * #891: an auto-approved receipt is a system note the harness writes as
 * "Auto-approved `<engine command>` — Full access" — the raw `tool {json}`.
 * This turns it into the same sentence the approval card shows
 * ("Auto-approved: Edit README.md (Full access)") and keeps the payload for
 * the Details disclosure. Anything else returns undefined and renders as-is.
 */
import { summariseApproval } from "./ask-line";

const RECEIPT = /^Auto-approved `([\s\S]+)` — Full access$/;

export interface ReceiptLine {
  /** The plain receipt sentence shown on the note. */
  text: string;
  /** The full engine command, behind Details. */
  details?: string;
}

export function summariseReceipt(text: string): ReceiptLine | undefined {
  const m = RECEIPT.exec(text);
  if (!m) return undefined;
  const { headline, details } = summariseApproval({ command: m[1] });
  return {
    text: `Auto-approved: ${headline.replace(/\?$/, "")} (Full access)`,
    details,
  };
}
