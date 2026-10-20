/* Cron-expression validity for scheduled tasks (#136). The v3 schedule
   editor (v3/v3-schedule-text.ts) gates Save on it; the relay re-checks with
   its own copy in contracts, so this only keeps a bad expression from being
   sent. */

const FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?$/;
const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

/* One cron field → the allowed values, or null when it doesn't parse. */
function cronField(src: string, [lo, hi]: [number, number]) {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    if (!FIELD.test(part)) return null;
    const [range, stepSrc] = part.split("/");
    const step = stepSrc ? Number(stepSrc) : 1;
    let [a, b] = [lo, hi];
    if (range !== "*") {
      const [x, y] = range.split("-").map(Number);
      a = x;
      b = y ?? (stepSrc ? hi : x);
    }
    if (a < lo || b > hi || a > b || step < 1) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

function parseCron(cron: string) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => cronField(p, RANGES[i]));
  return sets.every(Boolean) ? (sets as Set<number>[]) : null;
}

export const validCron = (cron: string) => !!parseCron(cron);
