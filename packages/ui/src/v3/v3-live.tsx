import { StatusPill } from "./v3-marks";
import type { V3Status, V3Thread } from "./v3-types";

/* Live-feel helpers for threads. The prototype has a fixed list of output
   lines per thread; these make it read as a stream that keeps arriving. */

/** "1m 42s" + n seconds → "1m 44s". Durations with no seconds part ("45m",
   "2h") are not live and come back unchanged. */
export function elapsedAt(base: string, seconds: number): string {
  if (!/\d+s\b/.test(base)) return base;
  const part = (re: RegExp) => Number(re.exec(base)?.[1] ?? 0);
  const total =
    part(/(\d+)h/) * 3600 + part(/(\d+)m/) * 60 + part(/(\d+)s/) + seconds;
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

/** The last `max` lines of a stream that replays the recorded lines forever.
   `key` is the position in the stream, so React animates only new lines.
   Lines that number their runs "(run 3)" keep counting across replays. */
export function streamTail(lines: string[], count: number, max: number) {
  const out: { key: number; text: string }[] = [];
  if (lines.length === 0) return out;
  const runs = lines.map((l) => Number(/\(run (\d+)\)/.exec(l)?.[1] ?? 0));
  const perLoop = Math.max(...runs);
  for (let i = Math.max(0, count - max); i < count; i++) {
    const loop = Math.floor(i / lines.length);
    out.push({
      key: i,
      text: lines[i % lines.length].replace(
        /\(run (\d+)\)/,
        (_, k) => `(run ${Number(k) + loop * perLoop})`,
      ),
    });
  }
  return out;
}

/** How many turns a thread has had, or undefined when the app does not carry
   its turns (then no label may say "0 turns"). */
export function turnCount(t: V3Thread): number | undefined {
  if (t.turns.length === 0) return undefined;
  return t.turns.reduce((m, x) => Math.max(m, x.n), 0);
}

/** A thread's status pill: a finished thread reads "Finished", not "Done". */
export function ThreadPill({ status }: { status: V3Status }) {
  return (
    <StatusPill
      status={status}
      label={status === "done" ? "Finished" : undefined}
    />
  );
}
