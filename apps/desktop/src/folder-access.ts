import {
  promises as fsp,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FolderAccessState } from "@lilos/contracts/app";
import {
  PROTECTED_FOLDERS,
  type ProtectedFolder,
  protectedFolderOf,
} from "@lilos/contracts/host";

/**
 * macOS "Files and Folders" consent, owned by the shell (D-#875): a read
 * inside ~/Desktop, ~/Documents or ~/Downloads blocks until the user
 * answers — and only THIS process's reads raise the answerable prompt (the
 * launchd relay/harness reads hang on a prompt nobody can see). The app's
 * ask step names the folders, `ask()` touches each one with a `readdir` so
 * the real "LilOS would like to access files in your Desktop folder" shows
 * while the user is looking.
 *
 * A touch is never timed out: the pending read IS the consent answer —
 * it resolves on grant, rejects (EPERM/EACCES) on denial, and parks while
 * the prompt is up. Settling whenever it lands is what "accept late
 * answers" means; a re-check on window focus picks up a grant given in
 * System Settings. `inflight` keeps each folder to one outstanding read so
 * repeat checks never pile threads on the same unanswered prompt.
 *
 * `asked` persists (a granted folder stays granted); `blocked` does not —
 * a denied read fails fast, so the boot probe re-derives it cheaply.
 * Off macOS the whole surface is empty — no prompts exist to ask for.
 */

export const FOLDER_ACCESS_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

const IS_MAC = process.platform === "darwin";

interface Persisted {
  asked?: string[];
}

const EMPTY: FolderAccessState = { pending: [], blocked: [] };

export class FolderAccess {
  private asked = new Set<string>();
  private blocked = new Set<string>();
  private inflight = new Map<string, Promise<void>>();
  private listeners = new Set<(s: FolderAccessState) => void>();
  private mac: boolean;
  /* E2E + non-interactive runs can't click an OS prompt; the flag skips
     the whole surface the way a granted install behaves — no touches at
     all, so nothing parks on an unanswerable TCC read (D-#875). */
  private skip: boolean;

  constructor(
    private opts: {
      stateFile: string;
      home?: string;
      /** Injectable touch — tests substitute answers and hangs. */
      read?: (abs: string) => Promise<unknown>;
      /** Tests run the state machine on Linux — a seam, not a prod path. */
      mac?: boolean;
    },
  ) {
    this.mac = opts.mac ?? IS_MAC;
    this.skip = !this.mac || process.env.LILOS_SKIP_FOLDER_ASK === "1";
    try {
      const raw = JSON.parse(readFileSync(opts.stateFile, "utf8")) as Persisted;
      for (const name of raw.asked ?? []) this.asked.add(name);
    } catch {
      /* no record yet — everything is pending */
    }
    if (this.skip) {
      for (const name of PROTECTED_FOLDERS) this.asked.add(name);
    }
  }

  private get home() {
    return this.opts.home ?? homedir();
  }

  private get read() {
    return this.opts.read ?? ((abs: string) => fsp.readdir(abs));
  }

  state(): FolderAccessState {
    if (!this.mac) return EMPTY;
    return {
      pending: PROTECTED_FOLDERS.filter((n) => !this.asked.has(n)),
      blocked: [...this.blocked].sort(),
    };
  }

  /** One read on the folder; its settle is the answer — resolved → asked
   *  and unblocked; refused → asked and blocked; still pending → the OS
   *  prompt is up and the answer is simply late. The returned promise
   *  settles with the read so a caller (`ensure`) can await the answer. */
  private touch(name: ProtectedFolder): Promise<void> {
    if (this.skip) return Promise.resolve();
    const inflight = this.inflight.get(name);
    if (inflight) return inflight;
    const askedWas = this.asked.has(name);
    const p = this.read(join(this.home, name))
      .then(() => {
        this.asked.add(name);
        this.blocked.delete(name);
      })
      .catch(() => {
        this.asked.add(name);
        this.blocked.add(name);
      })
      .finally(() => {
        this.inflight.delete(name);
        /* Only `asked` is persisted — write when it actually changed; a
           focus re-probe of already-asked folders doesn't rewrite the
           file three times over. `blocked` still emits (not persisted). */
        if (this.asked.has(name) !== askedWas) this.persist();
        this.emit();
      });
    this.inflight.set(name, p);
    return p;
  }

  /** Touch every unsettled folder — the OS prompts rise one after another
   *  while the ask step is on screen. */
  ask(): Promise<FolderAccessState> {
    for (const name of PROTECTED_FOLDERS) {
      if (!this.asked.has(name) || this.blocked.has(name)) {
        void this.touch(name);
      }
    }
    return Promise.resolve(this.state());
  }

  /** A folder the app just adopted (project add, thread move): a pending
   *  protected folder gets touched — the macOS prompt rises the moment the
   *  folder matters (D-#875 acceptance: adding a project inside Desktop
   *  must prompt). The await ends on the OS's answer: a grant lets the
   *  add proceed, a denial lets it hear FOLDER_ACCESS and resurface the
   *  step — a never-answered prompt just holds the await, like a modal.
   *  `~/x` expands under home. */
  ensure(path: string): Promise<FolderAccessState> {
    const abs =
      path === "~"
        ? this.home
        : path.startsWith("~/")
          ? join(this.home, path.slice(2))
          : path;
    const name = protectedFolderOf(abs, this.home);
    if (name && (!this.asked.has(name) || this.blocked.has(name))) {
      return this.touch(name).then(() => this.state());
    }
    return Promise.resolve(this.state());
  }

  /** Re-probe asked folders — at boot and on window focus. A granted read
   *  lands instantly and clears `blocked`; a denial answers instantly too;
   *  a never-answered prompt raises once more in a window that can show it.
   *  Pending folders stay untouched — the ask step explains first. */
  refreshBlocked(): Promise<FolderAccessState> {
    for (const name of PROTECTED_FOLDERS) {
      if (this.asked.has(name)) void this.touch(name);
    }
    return Promise.resolve(this.state());
  }

  onChange(cb: (s: FolderAccessState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    const s = this.state();
    for (const cb of this.listeners) cb(s);
  }

  private persist() {
    try {
      mkdirSync(dirname(this.opts.stateFile), { recursive: true });
      writeFileSync(
        this.opts.stateFile,
        JSON.stringify({ asked: [...this.asked] }),
      );
    } catch {
      /* state dir unwritable — the next launch just asks again */
    }
  }
}
