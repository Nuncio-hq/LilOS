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
 * while the user is looking, and a refused/still-waiting read marks the
 * folder `blocked` — the banner's System Settings button is the remedy.
 *
 * `asked` persists (a granted folder stays granted); `blocked` does not —
 * a denied read fails fast, so the boot probe re-derives it cheaply.
 * `LILOS_PROBE_TIMEOUT_MS` shortens the touch bound in tests.
 */

export const FOLDER_ACCESS_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

const probeTimeoutMs = () =>
  Number(process.env.LILOS_PROBE_TIMEOUT_MS ?? 8_000);

interface Persisted {
  asked?: string[];
}

export class FolderAccess {
  private asked = new Set<string>();
  private blocked = new Set<string>();
  private listeners = new Set<(s: FolderAccessState) => void>();

  constructor(
    private opts: {
      stateFile: string;
      home?: string;
      /** Injectable touch — tests substitute a never-landing read. */
      read?: (abs: string) => Promise<unknown>;
    },
  ) {
    try {
      const raw = JSON.parse(readFileSync(opts.stateFile, "utf8")) as Persisted;
      for (const name of raw.asked ?? []) this.asked.add(name);
    } catch {
      /* no record yet — everything is pending */
    }
  }

  private get home() {
    return this.opts.home ?? homedir();
  }

  private get read() {
    return this.opts.read ?? ((abs: string) => fsp.readdir(abs));
  }

  state(): FolderAccessState {
    return {
      pending: PROTECTED_FOLDERS.filter((n) => !this.asked.has(n)),
      blocked: [...this.blocked].sort(),
    };
  }

  /** One read on the folder, raced against the probe bound. Success or a
   *  fast refusal both settle it; a timeout means a prompt is still up —
   *  the folder reports blocked either way. */
  private async touch(name: ProtectedFolder): Promise<void> {
    const abs = join(this.home, name);
    try {
      await Promise.race([
        this.read(abs),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timed out")), probeTimeoutMs()),
        ),
      ]);
      this.asked.add(name);
      this.blocked.delete(name);
    } catch {
      this.asked.add(name);
      this.blocked.add(name);
    }
  }

  /** Touch every unsettled folder in order — one macOS prompt at a time. */
  async ask(): Promise<FolderAccessState> {
    for (const name of PROTECTED_FOLDERS) {
      if (!this.asked.has(name) || this.blocked.has(name as string)) {
        await this.touch(name);
      }
    }
    this.persist();
    this.emit();
    return this.state();
  }

  /** A folder the app just adopted (project add, thread move): if it sits
   *  inside a never-asked protected folder that folder is already pending
   *  — ensure() only confirms the state, the step/banner do the rest. An
   *  asked-but-blocked folder re-touches so an add right after the user
   *  granted settles it without a second click. `~/x` and relative paths
   *  expand under home, the way the app's folder paths spell. */
  async ensure(path: string): Promise<FolderAccessState> {
    const abs =
      path === "~"
        ? this.home
        : path.startsWith("~/")
          ? join(this.home, path.slice(2))
          : path;
    const name = protectedFolderOf(abs, this.home);
    if (name && this.blocked.has(name)) {
      await this.touch(name);
      this.persist();
      this.emit();
    }
    return this.state();
  }

  /** Re-probe asked folders at boot: a denial answers instantly, an
   *  unanswered prompt counts as blocked. Never touches a pending folder —
   *  the ask step explains first (D-#875). */
  async refreshBlocked(): Promise<FolderAccessState> {
    for (const name of PROTECTED_FOLDERS) {
      if (this.asked.has(name)) await this.touch(name);
    }
    this.persist();
    this.emit();
    return this.state();
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
        JSON.stringify({ asked: [...this.asked].sort() }),
      );
    } catch {
      /* state-dir write failure — in-memory state still answers */
    }
  }
}
