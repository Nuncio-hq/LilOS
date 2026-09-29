import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { BAD_PORTS, safePort } from "./ports";

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/

/* Every `wport(<n>)` base literal across the suite. A spec's ports are
   `base + TEST_WORKER_INDEX * 100`, so two DISTINCT bases sharing a
   residue mod 100 hand the same port to specs on different workers —
   worker 0's `4743` IS worker 1's `4643`, which let ac-27's stack ride
   ac-134's until teardown killed the ports mid-file (#256). Identical
   bases are fine: two spec files never share one live worker index. */
const BASES = [
  ...new Set(
    readdirSync(here)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
      .flatMap((f) =>
        [
          ...readFileSync(path.join(here, f), "utf8").matchAll(
            /\bwport\(\s*(\d+)/g,
          ),
        ].map((m) => Number(m[1])),
      ),
  ),
];

test("every wport call uses the default worker stride", () => {
  const custom: string[] = [];
  for (const f of readdirSync(here))
    if (f.endsWith(".ts") || f.endsWith(".tsx"))
      for (const m of readFileSync(path.join(here, f), "utf8").matchAll(
        /\bwport\(\s*\d+\s*,/g,
      ))
        custom.push(`${f}: ${m[0]}`);
  expect(custom).toEqual([]);
});

test("distinct wport bases never share a residue mod 100", () => {
  const byResidue = new Map<number, number[]>();
  for (const b of BASES)
    byResidue.set(b % 100, [...(byResidue.get(b % 100) ?? []), b]);
  const shared = [...byResidue.entries()].filter(([, v]) => v.length > 1);
  expect(shared).toEqual([]);
});

/* #164: a worker's port block must never land on a port that browsers and
   `fetch` refuse, or a healthy stack looks dead (worker 20 → 6668 was the
   flake). 5199 is the shared prototype webServer — a base ≡99 lands on it
   (worker 5 → 4699+500). Covers every base the specs use, up to worker
   index 200. */
const RESERVED = new Set([5199]);

test("no worker port is on the fetch bad-port list or a reserved port", () => {
  const bad: string[] = [];
  for (let w = 0; w <= 200; w++)
    for (const base of BASES) {
      const p = safePort(base + w * 100);
      if (BAD_PORTS.has(p) || RESERVED.has(p) || p > 65_535)
        bad.push(`${base}+${w}*100→${p}`);
    }
  expect(bad).toEqual([]);
});

test("the ports that broke CI are moved, others are untouched", () => {
  expect(safePort(6668)).not.toBe(6668);
  expect(safePort(5060)).not.toBe(5060);
  expect(safePort(6000)).not.toBe(6000);
  expect(safePort(4668)).toBe(4668);
});

test("undici fetch really refuses a bad port (the failure mode)", async () => {
  const err = await fetch("http://127.0.0.1:6668/").then(
    () => "connected",
    (e: Error) => String((e as { cause?: Error }).cause?.message ?? e.message),
  );
  expect(err).toMatch(/bad port/i);
});
