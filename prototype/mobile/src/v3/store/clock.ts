/* The mock day starts at 12:05 and moves with real time from load, so a
   message sent a minute later reads "12:06" and the clocks on turns, updates
   and asks agree. */
let loaded = Date.now();

export function resetClock(): void {
  loaded = Date.now();
}

/** `HH:MM` now, or `offsetMin` minutes from now (negative = earlier). */
export function clockAt(offsetMin = 0): string {
  const elapsed = Math.floor((Date.now() - loaded) / 60000);
  const m = (((12 * 60 + 5 + elapsed + offsetMin) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export const nowClock = (): string => clockAt(0);

/* Ids the store invents: a counter, never Math.random, so they are unique
   for the life of the app and the same run always yields the same ids. It
   deliberately survives a reset, so an old timer can never meet a reused id. */
let counter = 0;
export const uid = (prefix: string): string => `${prefix}-${++counter}`;
