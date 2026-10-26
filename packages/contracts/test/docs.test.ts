import { execSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The docs rules (docs/index.html#docs-rules) are repo state a later change
 * could undo by accident, so they get repo tests: one HTML page, no Markdown
 * sprawl, one line per decision, every decision anchored in the code that
 * carries its why, and every decision tag in code pointing at a decision
 * that is still in force.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SELF = "packages/contracts/test/docs.test.ts";
const DOC = "docs/index.html";
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const doc = read(DOC);

/** Budgets: the page and the auto-loaded agent file stay small enough to
 *  read whole. Raising one is a decision — prune stale entries first. */
const DOC_MAX_BYTES = 56_000;
const AGENTS_MAX_CHARS = 2_400;
const DECISION_MAX_CHARS = 300;

/** Markdown another tool requires: GitHub (README, CONTRIBUTING, SECURITY,
 *  issue templates), legal (LICENSE, notices), agent loaders (AGENTS.md, its
 *  CLAUDE.md link, skills). Everything else belongs in docs/index.html. */
const MARKDOWN_ALLOWED = [
  /^(README|CONTRIBUTING|SECURITY|LICENSE|THIRD_PARTY_NOTICES|AGENTS|CLAUDE)\.md$/,
  /^\.github\/ISSUE_TEMPLATE\/[^/]+\.md$/,
  /^\.agents\/skills\/[^/]+\/SKILL\.md$/,
  /* D-#835: SKILL.md is the skill format the `lilos` engine plugin ships —
     `register_skill` requires that exact name under its skills/ dir. (The
     engine package name stays unwritten: this file is itself on the
     vendor-neutral seam.) */
  /^packages\/engine-[^/]+\/plugin\/[^/]+\/skills\/[^/]+\/SKILL\.md$/,
];

const TAG = "D-" + "#"; // split so this file never cites a decision itself
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** A decision line: `<li id="d-N">` … `<em>Not: …</em>` `<small>refs</small>`
 *  then the code files that carry its tag as `<kbd>path</kbd>`. */
type Entry = { id: string; n: string; html: string; src: string[] };
const entries: Entry[] = [
  ...doc.matchAll(/<li id="(d-(\d+)(?:-\d+)?)">(.*)<\/li>/g),
].map(([, id, n, html]) => ({
  id,
  n,
  html,
  src: [...html.matchAll(/<kbd>([^<]+)<\/kbd>/g)].map((m) => m[1]),
}));
const inForce = new Set(entries.map((e) => e.n));
const ids = new Set([...doc.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

describe("one document", () => {
  it("only the Markdown another tool requires is tracked", () => {
    const stray = tracked.filter(
      (f) => /\.mdx?$/i.test(f) && !MARKDOWN_ALLOWED.some((re) => re.test(f)),
    );
    expect(stray, "move it into docs/index.html or the code").toEqual([]);
  });

  it("docs/ holds only the page and its images", () => {
    const extra = tracked.filter(
      (f) =>
        f.startsWith("docs/") &&
        f !== DOC &&
        !/^docs\/img\/[^/]+\.(png|jpe?g|svg|webp)$/.test(f),
    );
    expect(extra).toEqual([]);
  });

  it("AGENTS.md is a short pointer to the page; CLAUDE.md links to it", () => {
    const agents = read("AGENTS.md");
    expect(agents).toContain(DOC);
    expect(agents.length).toBeLessThanOrEqual(AGENTS_MAX_CHARS);
    expect(lstatSync(join(ROOT, "CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(ROOT, "CLAUDE.md"))).toBe("AGENTS.md");
  });

  it("the page stays lean", () => {
    expect(Buffer.byteLength(doc)).toBeLessThanOrEqual(DOC_MAX_BYTES);
  });
});

describe("decisions: one line here, the why at the code", () => {
  it("every entry opens and closes on one line", () => {
    const opened = doc.match(/<li id="d-/g)?.length ?? 0;
    expect(entries.length).toBe(opened);
    expect(entries.length).toBeGreaterThan(40);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });

  it("every entry is short and says what was rejected", () => {
    for (const e of entries) {
      expect(e.html, `${e.id} needs an <em>Not: …</em>`).toMatch(
        /<em>Not: \S.*?<\/em>/,
      );
      // Measure the rule + rejection; the refs and file paths don't count.
      const text = textOf(e.html.replace(/<(small|kbd)>[^<]*<\/\1>/g, ""));
      expect(
        text.length,
        `${e.id} is ${text.length} chars: the detail belongs in its code`,
      ).toBeLessThanOrEqual(DECISION_MAX_CHARS);
    }
  });

  it("every entry names a tracked file that carries its tag", () => {
    const files = new Set(tracked);
    for (const e of entries) {
      expect(e.src.length, `${e.id} names no code`).toBeGreaterThan(0);
      for (const path of e.src) {
        expect(files.has(path), `${e.id}: ${path} is not tracked`).toBe(true);
        expect(
          new RegExp(`${TAG}${e.n}(?!\\d)`).test(read(path)),
          `${path} must say ${TAG}${e.n} where the rule lives (${e.id})`,
        ).toBe(true);
      }
    }
  });

  it("every tag in the code names a decision in force", () => {
    const stale: string[] = [];
    for (const f of tracked) {
      if (f === DOC || f === SELF || f === "bun.lock") continue;
      if (/\.(png|jpe?g|gif|ico|icns|webp|ttf|otf|woff2?|mp4|zip)$/i.test(f))
        continue;
      const path = join(ROOT, f);
      if (!existsSync(path) || lstatSync(path).isSymbolicLink()) continue;
      for (const m of read(f).matchAll(new RegExp(`${TAG}(\\d+)`, "g"))) {
        if (!inForce.has(m[1])) stale.push(`${f}: ${TAG}${m[1]}`);
      }
    }
    expect(stale, "cite a decision in force, or add/restore its entry").toEqual(
      [],
    );
  });
});

describe("links resolve", () => {
  it("in-page links land on an id", () => {
    const dead = [...doc.matchAll(/href="#([^"]+)"/g)]
      .map((m) => m[1])
      .filter((id) => !ids.has(id));
    expect(dead).toEqual([]);
  });

  it("files citing docs/index.html#… cite an id the page has", () => {
    const dead: string[] = [];
    for (const f of tracked) {
      if (f === DOC || !/\.(ts|tsx|mts|sh|ya?ml|py|css|md|html)$/.test(f))
        continue;
      for (const m of read(f).matchAll(/docs\/index\.html#([\w-]+)/g)) {
        if (!ids.has(m[1])) dead.push(`${f}: #${m[1]}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it("repo paths the page names exist", () => {
    /* The "Learn from" table names paths in other projects; skip it. */
    const learn = doc.match(/<h3 id="learn">[\s\S]*?<\/table>/)?.[0] ?? "";
    const gone = [
      ...doc.replace(learn, "").matchAll(/<(code|kbd)>([^<]+)<\/\1>/g),
    ]
      .map((m) => m[2])
      .filter((p) =>
        /^(apps|packages|prototype|scripts|e2e|site|docs|\.github|\.agents)\/[\w./-]+$/.test(
          p,
        ),
      )
      .filter((p) => !existsSync(join(ROOT, p)));
    expect(gone).toEqual([]);
  });
});
