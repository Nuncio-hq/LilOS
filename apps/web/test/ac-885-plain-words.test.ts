import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/* Issue #885: nothing a user sees names LilOS's insides — no "employee",
   "hire(d)", "CEO", "acp:…", "harness", "relay" or "engine-fake" in the
   user-visible strings of apps/web and packages/ui.

   What counts as user-visible: quoted literals and JSX text that read like
   prose — not identifiers, import paths, wire values or comments (those are
   stripped). Code-shaped tokens (lowercase, no spaces, path-like) never
   render as words, so they never flag.

   Two narrow escapes, each pinned to a file and the words it keeps:
   - Troubleshooting and the status/diagnostics surface keep the real
     names — that is what a bug report quotes (#885's own allow-list).
   - The paused company layer (D-#836) keeps its words until it returns:
     they are unreachable while `features.company` is false. */

const BANNED: Record<string, RegExp> = {
  employee: /\bemployee(s|'s)?\b/i,
  hire: /\bhir(ed|es|ing|e)\b/i,
  CEO: /\bCEO\b/,
  "acp:": /acp:/i,
  harness: /\bharness\b/i,
  relay: /\brelay\b/i,
  "engine-fake": /\bengine[-\s]?fake\b/i,
};

/** file (repo-relative) -> banned keys that stay allowed there, with why.
    An entry that stops matching a real string fails the test: an old
    excuse must not hide a new sentence. `strings` pins the allowance to
    listed substrings — anything else banned in the same file still flags
    (#885: a whole-file excuse must not hide a new sentence). */
const ALLOW: Record<
  string,
  { words: string[]; why: string; strings?: string[] }
> = {
  /* #885's own escape hatch: the Troubleshooting surface keeps the real
     names, because that is what a bug report quotes. */
  "packages/ui/src/v3/v3-settings-trouble.tsx": {
    words: ["relay"],
    why: "the Troubleshooting surface itself",
  },
  "packages/ui/src/shell/status.tsx": {
    words: ["relay", "harness"],
    why: "the system-status dialog — same diagnostics surface",
  },

  /* The paused company layer (D-#836): `ceoId` and tickets are stripped
     while the flag is off, so none of this renders today; the words return
     when the layer does. */
  "packages/ui/src/v3/v3-welcome.tsx": {
    words: ["CEO"],
    why: "company-mode first-run copy",
  },
  "packages/ui/src/v3/v3-hire.tsx": {
    words: ["CEO", "hire"],
    why: "Hire page",
  },
  "packages/ui/src/v3/v3-hire-profiles.tsx": {
    words: ["hire"],
    why: "Hire page's existing-profiles section",
  },
  "packages/ui/src/v3/v3-guide.tsx": {
    words: ["CEO"],
    why: "the ticket-mode guide",
  },
  "packages/ui/src/v3/v3-palette.tsx": {
    words: ["CEO"],
    why: "⌘K's ask-the-CEO lines",
  },
  "packages/ui/src/v3/v3-palette-plan.tsx": {
    words: ["CEO"],
    why: "the plan draft",
  },
  "packages/ui/src/v3/v3-people.tsx": {
    words: ["CEO"],
    why: "People page",
  },
  "packages/ui/src/v3/v3-model.ts": {
    words: ["CEO"],
    why: "what a ticket waits on",
  },
  "packages/ui/src/v3/v3-marks.tsx": {
    words: ["CEO"],
    why: "the CEO mark",
  },
  "packages/ui/src/v3/v3-needs.tsx": {
    words: ["CEO"],
    why: "company-gated rows",
  },
  "packages/ui/src/v3/v3-needs-ask.tsx": {
    words: ["CEO"],
    strings: ["the CEO"],
    why: "the company-gated fallback chip's fixed part",
  },
  "packages/ui/src/v3/v3-page-view.tsx": {
    words: ["hire"],
    why: "the Hire page's title",
  },
  "packages/ui/src/v3/v3-sidebar.tsx": {
    words: ["hire"],
    why: "the company-gated Hire button",
  },
  "packages/ui/src/v3/v3-ticket.tsx": {
    words: ["CEO"],
    why: "the ticket page",
  },
  "packages/ui/src/v3/v3-ticket-notes.tsx": {
    words: ["CEO"],
    why: "ticket notes",
  },
  "packages/ui/src/v3/v3-work-views.tsx": {
    words: ["CEO"],
    why: "work views",
  },
  "packages/ui/src/v3/v3-agent-rules.tsx": {
    words: ["CEO"],
    why: "the rule suggestion on an agent's page",
  },
  "packages/ui/src/v3/v3-home.tsx": {
    words: ["CEO"],
    why: "the CEO's-next-run row, company-gated",
  },
  "apps/web/src/v3/actions.ts": {
    words: ["CEO"],
    strings: ["Couldn't make them CEO"],
    why: "the company-layer toast",
  },

  /* #872's scope (the add-agent dialog and the agent page): the rewording
     of these strings lands in that PR — allow-listed here so the two
     landings do not collide. */
  "packages/ui/src/v3/v3-add-agent.tsx": {
    words: ["hire"],
    why: "the add-agent dialog — #872",
  },
  "packages/ui/src/v3/v3-agent.tsx": {
    words: ["CEO"],
    why: "the agent page — #872",
  },
};

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(WEB, "..", "..");
const SCOPES = [join(WEB, "src"), join(REPO, "packages", "ui", "src")];
const SCAN = /\.(ts|tsx)$/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") yield* walk(join(dir, entry.name));
    } else if (SCAN.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

/** Comments gone; strings and JSX text keep their contents. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/* A literal is user-visible only if it is not a code token: lowercase
   identifiers, paths, keys, urls and wire values all sit inside the code
   shape `a-z` + `.~@-_/:\+` and never render as words. */
const CODE_TOKEN = /^[\s]*[a-z0-9_.~@\-/:+\\]+[\s]*$/;

/* Quote handling that survives apostrophes: `'`/`"` open a string only
   after a non-word char (so "don't" in JSX text never starts one), and a
   `"`-string happily contains `'`. Template literals may span lines. */
const LITERALS = [
  /(?<![\w$])"(?:[^"\\\n]|\\[\s\S])*"/g,
  /(?<![\w$])'(?:[^'\\\n]|\\[\s\S])*'/g,
  /(?<![\w$])`(?:[^`\\]|\\[\s\S])*`/gs,
];

function* visibleStrings(src: string): Generator<string> {
  let clean = stripComments(src);
  const unquote = (s: string) => s.slice(1, -1);
  for (const re of LITERALS) {
    for (const m of clean.matchAll(re)) {
      const s = unquote(m[0]).replace(/\$\{[^}]*\}/g, " ");
      /* Code tokens never render as words — except `acp:`, which IS the
         banned thing wherever it appears. */
      if (CODE_TOKEN.test(s) && !BANNED["acp:"].test(s)) continue;
      yield s;
    }
    // Blank the matched literals so leftover `>`/`<` (and stray quotes in
    // JSX text like "don't") can't desync the JSX-text pass.
    clean = clean.replace(re, '""');
  }
  /* JSX text between tags, including the segments around a {expr}: the
     run ends at the next `<`, and only flat `{…}` expressions fit (a
     nested element inside braces doesn't — those literals were already
     scanned above). `=>`/`->` before the `>` means it was code. */
  for (const m of clean.matchAll(
    /(?<![=-])>([^<>"`{}]*(?:\{[^{}]*\}[^<>"`{}]*)*)</g,
  )) {
    const s = m[1].replace(/\{[^{}]*\}/g, " ");
    if (!/[a-zA-Z]/.test(s)) continue;
    if (/;|=>|\bconst\b|\breturn\b|=/.test(s)) continue;
    yield s;
  }
}

describe("no internal names where a user reads (#885)", () => {
  test("user-visible strings in apps/web and packages/ui stay plain", () => {
    const hits: string[] = [];
    const allowUse = new Map<string, Set<string>>();
    const allowTextUse = new Map<string, Set<string>>();
    for (const scope of SCOPES) {
      for (const file of walk(scope)) {
        const rel = relative(REPO, file);
        const entry = ALLOW[rel];
        const strings = [...visibleStrings(readFileSync(file, "utf8"))];
        for (const [key, re] of Object.entries(BANNED)) {
          for (const s of strings) {
            if (!re.test(s)) continue;
            const pin = entry?.strings?.find((sub) => s.includes(sub));
            if (entry?.words.includes(key) && (!entry.strings || pin)) {
              const used = allowUse.get(rel) ?? new Set<string>();
              allowUse.set(rel, used);
              used.add(key);
              if (pin) {
                const usedText = allowTextUse.get(rel) ?? new Set<string>();
                allowTextUse.set(rel, usedText);
                usedText.add(pin);
              }
              continue;
            }
            hits.push(`${rel}  ${key}:  "${s.trim().slice(0, 80)}"`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
    // An allowance nobody needs anymore is itself flagged: it would hide a
    // new sentence behind an old excuse.
    const stale = Object.entries(ALLOW)
      .filter(
        ([f, { words, strings }]) =>
          words.some((w) => !allowUse.get(f)?.has(w)) ||
          strings?.some((sub) => !allowTextUse.get(f)?.has(sub)),
      )
      .map(([f, { words, why }]) => `${f} (${words.join(", ")} — ${why})`);
    expect(stale).toEqual([]);
  });
});
