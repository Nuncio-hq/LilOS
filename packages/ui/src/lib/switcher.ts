/* ⌘K quick switcher: one fuzzy pass over employees, sessions and folders.
   The host builds the items; this file owns matching + ordering so the same
   search runs in the prototype, the app and the perf test. */

export type SwitcherKind = "employee" | "session" | "folder";

export interface SwitcherItem {
  kind: SwitcherKind;
  /** The pick's target — what onPick needs to open it (employee id,
      conversation id, folder id). */
  id: string;
  /** Headline row: employee name, session title, folder label. */
  title: string;
  /** Dim second line: role, first message, path. */
  subtitle?: string;
  /** Extra match text that never renders — a session's first message when a
      title took the headline. */
  match?: string;
  /** A turn is live. */
  running?: boolean;
  /** Parked on an approval/question — outranks running for attention. */
  needsYou?: boolean;
  /** Archived sessions stay searchable but sink below live rows. */
  archived?: boolean;
}

/* Section order as the rows render: people first, then threads, then
   places — the order the eye scans a Slack-style palette in. */
const KIND_ORDER: SwitcherKind[] = ["employee", "session", "folder"];

/* Per-section caps so one long session list can't crowd out the rest.
   Loose enough that typing narrows before scrolling does. */
const CAPS: Record<SwitcherKind, number> = {
  employee: 6,
  session: 14,
  folder: 6,
};

/* Fuzzy score, same family as the host's fs search: a substring hit in the
   title outranks one in the extra match text; an in-order subsequence is
   the weakest. null = the term didn't match at all and the row is out. */
function termScore(title: string, match: string, term: string): number | null {
  const ti = title.indexOf(term);
  if (ti !== -1) return 2000 - ti - title.length / 100;
  const mi = match.indexOf(term);
  if (mi !== -1) return 1000 - mi - match.length / 100;
  let qi = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < title.length && qi < term.length; i++) {
    if (title[i] === term[qi]) {
      if (first === -1) first = i;
      last = i;
      qi++;
    }
  }
  if (qi < term.length) return null;
  return 500 - (last - first);
}

/**
 * Filter + rank `items` for `query`. Multi-term queries AND together; an
 * empty query returns every item in input order. Output is grouped by kind
 * (KIND_ORDER), each group score-sorted and capped — one flat array the
 * view walks, emitting a heading whenever the kind changes.
 */
export function searchSwitcher(
  items: readonly SwitcherItem[],
  query: string,
): SwitcherItem[] {
  const q = query.trim().toLowerCase();
  const scored: { item: SwitcherItem; score: number }[] = [];
  for (const item of items) {
    let score = 0;
    if (q) {
      const title = item.title.toLowerCase();
      const match = `${item.subtitle ?? ""}\n${item.match ?? ""}`.toLowerCase();
      let s: number | null = 0;
      for (const term of q.split(/\s+/)) {
        const t = termScore(title, match, term);
        if (t === null) {
          s = null;
          break;
        }
        s += t;
      }
      if (s === null) continue;
      score = s;
    }
    scored.push({ item, score });
  }
  const out: SwitcherItem[] = [];
  for (const kind of KIND_ORDER) {
    const group = scored
      .filter((s) => s.item.kind === kind)
      /* Archived rows sink within the group: an open session with a weak
         match beats a buried one with a strong match. */
      .sort(
        (a, b) =>
          Number(a.item.archived ?? false) - Number(b.item.archived ?? false) ||
          b.score - a.score,
      );
    out.push(...group.slice(0, CAPS[kind]).map((s) => s.item));
  }
  return out;
}
