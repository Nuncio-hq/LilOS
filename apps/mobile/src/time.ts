/* Tiny shared clock labels — kept dependency-free so screens can format
   last-seen ages without importing the app shell. */

/** "just now" | "N min ago" | "N hr ago" | "N days ago" — a last-seen age. */
export function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} days ago`;
}
