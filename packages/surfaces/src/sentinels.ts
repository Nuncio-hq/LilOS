import { MARKER_PREFIX } from "./scope.js";

/**
 * Viewer-side sentinel filter (issue #69). `terminal_run` writes a
 * `printf '__LILOS_DONE_<n>__%s\n' "$?"` sentinel after each command; its
 * echo and the marker output line are agent plumbing the human must never
 * see. The PTY, the scrollback tail (`terminal_read`), and the `termTaps`
 * capture the agent relies on stay raw — only the viewer stream
 * (`attachViewer`: the snapshot tail and live `term` events) runs through
 * this filter.
 *
 * Lines containing the marker are dropped whole: dropping the echo line also
 * drops the prompt printed just before it, but the shell redraws a fresh
 * prompt after the run, so the transcript reads clean.
 *
 * Chunks can split a marker anywhere, so the trailing unterminated line is
 * emitted except for a held-back suffix that could still be the start of a
 * marker (at most `MARKER_PREFIX.length - 1` chars — prompts and keystroke
 * echoes flush immediately). If a line turns out tainted after part of it
 * was already emitted, a `\r`-overwrite of spaces erases the fragment — the
 * Terminal pane resolves `\r`s in the joined transcript before rendering.
 */
export class ViewerTermFilter {
  private pending = "";
  /** Dropping the rest of a tainted line until its `\n`. */
  private suppressing = false;
  /** Chars of the current line already emitted — the span to erase on taint. */
  private emittedOnLine = 0;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  /** Feed one PTY chunk; returns the bytes safe to forward to the viewer. */
  push(chunk: Uint8Array): Uint8Array {
    return this.encoder.encode(
      this.feed(this.decoder.decode(chunk, { stream: true })),
    );
  }

  private feed(text: string): string {
    this.pending += text;
    let out = "";
    for (;;) {
      const nl = this.pending.indexOf("\n");
      if (nl < 0) break;
      const line = this.pending.slice(0, nl + 1);
      this.pending = this.pending.slice(nl + 1);
      if (this.suppressing) {
        this.suppressing = false;
      } else if (line.includes(MARKER_PREFIX)) {
        if (this.emittedOnLine > 0) out += eraseLine(this.emittedOnLine);
      } else {
        out += line;
      }
      this.emittedOnLine = 0;
    }
    if (this.suppressing) {
      this.pending = "";
    } else if (this.pending.includes(MARKER_PREFIX)) {
      this.suppressing = true;
      if (this.emittedOnLine > 0) out += eraseLine(this.emittedOnLine);
      this.emittedOnLine = 0;
      this.pending = "";
    } else if (this.pending.length > 0) {
      const hold = holdbackLen(this.pending);
      const emit = this.pending.slice(0, this.pending.length - hold);
      out += emit;
      this.emittedOnLine += emit.length;
      this.pending = hold ? this.pending.slice(-hold) : "";
    }
    return out;
  }
}

/** Overwrite `n` emitted chars with blanks — `\r`, spaces, `\r` back. */
const eraseLine = (n: number) => `\r${" ".repeat(n)}\r`;

/**
 * Length of the pending suffix that could still grow into a marker — the
 * longest proper prefix of `MARKER_PREFIX` the pending text ends with.
 */
function holdbackLen(pending: string): number {
  const max = Math.min(pending.length, MARKER_PREFIX.length - 1);
  for (let k = max; k > 0; k--) {
    if (pending.endsWith(MARKER_PREFIX.slice(0, k))) return k;
  }
  return 0;
}
