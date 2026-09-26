/**
 * In-memory ring buffer of relay log lines (issue #33). Diagnostics only need
 * the recent tail, and the bundle is fetched over the socket — so when the
 * relay is down there is nobody to serve a persisted file anyway.
 */
export interface LogTail {
  log(message: string): void;
  /** Newest `n` lines, oldest first. */
  tail(n: number): string[];
}

export function createLogTail(
  capacity = 500,
  now: () => number = () => Date.now(),
): LogTail {
  const lines: string[] = [];
  return {
    log(message) {
      lines.push(`${new Date(now()).toISOString()} ${message}`);
      if (lines.length > capacity) lines.splice(0, lines.length - capacity);
    },
    tail(n) {
      if (n <= 0) return [];
      return lines.slice(Math.max(0, lines.length - n));
    },
  };
}
