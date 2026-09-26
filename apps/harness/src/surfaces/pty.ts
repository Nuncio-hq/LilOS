import type { PtyHandle, PtySpawnOptions } from "@lilos/surfaces";

/**
 * The harness-owned PTY (issue #36, AC-1): a login shell on Bun's native
 * `terminal` spawn option — survives viewers disconnecting; `SessionSurfaces`
 * respawns it on exit. Bun-only, so it lives at the app entry (AGENTS.md).
 */
export function bunPtySpawner(
  opts: PtySpawnOptions,
  onData: (chunk: Uint8Array) => void,
  onExit: (code: number) => void,
): PtyHandle {
  const shell = process.env.SHELL ?? "/bin/bash";
  const proc = Bun.spawn([shell, "-l"], {
    terminal: {
      cols: opts.cols,
      rows: opts.rows,
      name: "xterm-256color",
      data: (_t, chunk) => onData(chunk),
    },
    cwd: opts.cwd ?? process.env.HOME ?? process.cwd(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    } as Record<string, string>,
  });
  void proc.exited.then((code) => onExit(code));
  const term = proc.terminal;
  return {
    write: (data) => term?.write(data),
    resize: (cols, rows) => {
      try {
        term?.resize?.(cols, rows);
      } catch {
        /* PTY dying mid-resize is harmless */
      }
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
    },
  };
}
