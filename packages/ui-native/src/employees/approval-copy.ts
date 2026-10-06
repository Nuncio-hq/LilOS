import type { Approval } from "./types";

/* #264 — the one sentence an approval surface says above its command box.
   The wire's `description` is the engine's own "wants to run: <cmd>" echo
   (and the row's `reason` is the command itself once it's stripped), so a
   reason that merely contains the command would say it twice — once in the
   sentence and again in the box. Then the sentence is just
   "<employee> wants to run" and the box carries the command. A reason that
   says something else is a real why (prototype rows write one) and stays. */
export function approvalSentence(
  a: Pick<Approval, "employee" | "reason"> & { command?: string },
): string {
  if (a.command && a.reason.includes(a.command))
    return `${a.employee} wants to run`;
  return a.reason;
}

/* Lines break only between arguments, and a flag stays with its value
   ("--env dev"): non-breaking hyphens + a no-break space after a flag. */
export function keepFlags(command: string) {
  return command
    .replace(/(^|\s)(-{1,2}[\w-]+) (?=[^-\s])/g, "$1$2 ")
    .replace(/-/g, "‑");
}

/* #652 AC-2: one human description for an ask's command, shared by the
   Home accessory, the Activity card and the thread ask card. A file tool
   reads "wants to edit/write <basename>" (full path as `detail` — the
   card's second line), a real shell command keeps its `$` box (`boxed`),
   an unknown tool reads "wants to use <tool>" with the raw args as
   `detail` (the card puts them behind a tap). The `line` never carries
   raw JSON or a `$ ` prompt. */

export type AskDescription = {
  /** "wants to edit README.md" — the sentence fragment after <employee>. */
  line: string;
  /** Full path or raw args — a second line on the card / behind a tap. */
  detail?: string;
  /** Verb + full path — the one-line surfaces' tail when a dir adds context. */
  full?: string;
  /** A real shell command — renders in the `$` box. */
  boxed?: string;
};

const FILE_VERBS: Record<string, string> = {
  write_file: "wants to write",
  patch: "wants to edit",
  apply_patch: "wants to edit",
  edit: "wants to edit",
  edit_file: "wants to edit",
  str_replace_editor: "wants to edit",
  read_file: "wants to read",
};
const PATH_KEYS = ["path", "file", "file_path", "target_file", "filename"];
const SHELL_TOOLS = new Set(["terminal", "shell", "bash", "sh", "exec"]);

const baseName = (p: string) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
};

function argsPath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  for (const k of PATH_KEYS) {
    const v = a[k];
    if (typeof v === "string" && v) return v;
  }
  const diff = a.diff;
  if (diff && typeof diff === "object") {
    const p = (diff as Record<string, unknown>).path;
    if (typeof p === "string" && p) return p;
  }
  return undefined;
}

export function describeAsk(command?: string): AskDescription | undefined {
  if (!command) return undefined;
  const m = command.match(/^([\w.-]+)\s+(\{.*\})$/s);
  if (!m) return { line: "wants to run", boxed: command };
  const [, tool, raw] = m;
  let args: unknown;
  try {
    args = JSON.parse(raw);
  } catch {
    return { line: `wants to use ${tool}`, detail: raw };
  }
  if (SHELL_TOOLS.has(tool)) {
    const cmd =
      args && typeof args === "object"
        ? (args as Record<string, unknown>).command
        : undefined;
    return {
      line: "wants to run",
      boxed: typeof cmd === "string" && cmd ? cmd : command,
    };
  }
  const verb = FILE_VERBS[tool];
  if (verb) {
    const p = argsPath(args);
    if (!p) return { line: `wants to use ${tool}`, detail: raw };
    const b = baseName(p);
    return {
      line: `${verb} ${b}`,
      detail: p !== b ? p : undefined,
      full: `${verb} ${p}`,
    };
  }
  return { line: `wants to use ${tool}`, detail: raw };
}

/* #652: one-line human ask description — the same sentence the thread
   card leads with. File tools describe the file, a shell command keeps
   its `· <cmd>` tail; never a `$ patch {…}` terminal box. Shared by the
   Home accessory and the Activity card. */
export function whatLine(
  a: Pick<Approval, "employee" | "reason"> & {
    command?: string;
    file?: { name: string };
  },
): string {
  const d = describeAsk(a.command);
  const echo = !!a.command && a.reason.includes(a.command);
  if (d?.boxed) return `${approvalSentence(a)} · ${keepFlags(d.boxed)}`;
  if (d)
    return echo
      ? `${a.employee} ${d.full ?? d.line}`
      : `${approvalSentence(a)} · ${d.full ?? d.line}`;
  return a.file
    ? `${approvalSentence(a)} · ${a.file.name}`
    : approvalSentence(a);
}

/** The thread ask card's sentence — basename form (`detail` renders as
    the second line there), while `whatLine` packs the full path into its
    single line. Shell commands keep the "wants to run" lead; the `$` box
    carries the command itself. */
export function cardLine(
  a: Pick<Approval, "employee" | "reason"> & {
    command?: string;
    file?: { name: string };
  },
): string {
  const d = describeAsk(a.command);
  if (!d)
    return a.file
      ? `${approvalSentence(a)} · ${a.file.name}`
      : approvalSentence(a);
  if (d.boxed) return approvalSentence(a);
  const echo = !!a.command && a.reason.includes(a.command);
  return echo
    ? `${a.employee} ${d.line}`
    : `${approvalSentence(a)} · ${d.line}`;
}

/** The accessory's `what` — the human line above, with "Last known"
    leading while offline so truncation can't cut the marker away. */
export function accessoryWhat(
  a: Pick<Approval, "employee" | "reason" | "lastKnown"> & {
    command?: string;
    file?: { name: string };
  },
): string {
  return `${a.lastKnown ? "Last known · " : ""}${whatLine(a)}`;
}
