import { expect, test } from "@playwright/test";
import { BAD_PORTS, safePort } from "./ports";

/* #164: a worker's port block must never land on a port that browsers and
   `fetch` refuse, or a healthy stack looks dead (worker 20 → 6668 was the
   flake). Covers every base/step the specs use, up to worker index 200. */
const BASES = [
  4643, 4647, 4653, 4654, 4656, 4657, 4660, 4661, 4663, 4664, 4665, 4667, 4668,
  4669, 4670, 4671, 4674, 4675, 4676, 4680, 4681, 4688, 4692, 4700, 4705, 4710,
  4714, 4720, 4721, 4723, 4724, 4740, 4741, 4743, 4747, 4753, 4754, 4760, 4761,
  4780, 4781, 5241, 5245, 5255, 5258, 5262, 5264, 5266, 5270, 5273, 5274, 5277,
  5280, 5281, 5290, 5292, 5300, 5301, 5340, 5341, 5345, 5360, 5380,
];

test("no worker port is on the fetch bad-port list", () => {
  const bad: string[] = [];
  for (const step of [10, 100])
    for (let w = 0; w <= 200; w++)
      for (const base of BASES) {
        const p = safePort(base + w * step);
        if (BAD_PORTS.has(p) || p > 65_535)
          bad.push(`${base}+${w}*${step}→${p}`);
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
