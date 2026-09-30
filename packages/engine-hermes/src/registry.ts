import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * #288: what a restarted adapter needs to `session.resume` the SAME stored
 * Hermes session — its durable ref (stored_session_id), the profile the
 * session was created under (resume only searches that profile's state.db),
 * and the metadata the resumed Session object mirrors (model pick, cwd,
 * rewind baseline). Written by the serve entry under the harness home so a
 * harness restart — which kills `hermes serve` and this adapter with it —
 * rebinds each conversation's existing session instead of minting a new one.
 */
export interface StoredSession {
  /** Durable stored_session_id — rotates on compression; kept current by
     `session.info`/`session.title` sightings. */
  ref: string;
  /** Hermes profile the session was created under (the LilOS agent). */
  agent: string;
  cwd: string;
  model?: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
  /** user inputs delivered — `session.rewind`'s toTurn baseline (#134). */
  userTurns: number;
}

/**
 * Flat-file registry `engine session id -> StoredSession`, updated
 * write-through on every mutation that matters for resume (start, prompts,
 * steers, rewinds, ref rotations) and removed on `session.stop`. Reads are
 * lazy and failures never take the engine down: an unreadable or unwritable
 * file degrades resume to the `session.start` fallback.
 */
export class SessionRegistry {
  private rows?: Map<string, StoredSession>;

  constructor(private readonly file: string) {}

  get(id: string): StoredSession | undefined {
    return this.load().get(id);
  }

  put(id: string, row: StoredSession): void {
    this.load().set(id, row);
    this.write();
  }

  delete(id: string): void {
    if (this.load().delete(id)) this.write();
  }

  private load(): Map<string, StoredSession> {
    if (this.rows) return this.rows;
    this.rows = new Map();
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as {
          sessions?: Record<string, StoredSession>;
        };
        for (const [id, row] of Object.entries(parsed.sessions ?? {})) {
          if (row && typeof row.ref === "string" && row.ref) {
            this.rows.set(id, row);
          }
        }
      }
    } catch {
      /* A corrupt file starts empty — resume falls back to session.start. */
    }
    return this.rows;
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        `${JSON.stringify({ sessions: Object.fromEntries(this.load()) }, null, 2)}\n`,
      );
      renameSync(tmp, this.file);
    } catch {
      /* best effort */
    }
  }
}
