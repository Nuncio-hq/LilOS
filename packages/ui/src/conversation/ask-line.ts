/**
 * #884: one plain sentence for an approval request — "Edit README.md?",
 * "Run `bun run verify` in lilos?" — plus the FULL payload under a Details
 * disclosure, because an approval you cannot inspect is a signature you
 * cannot see. Every surface that asks for a decision (the thread card,
 * Home's needs-you row, the Needs page) renders this one shape, so the
 * question reads the same everywhere and nobody sees raw JSON.
 */

/** How long an embedded name/path/command may run before it truncates. */
const MAX_TARGET = 72;

/** Shared clipping state — a summarising pass sets `clipped` the moment any
    embedded text was cut, which is one reason Details starts open. */
interface St {
  clipped: boolean;
}

function clip(s: string, st: St): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= MAX_TARGET) return t;
  st.clipped = true;
  return `${t.slice(0, MAX_TARGET - 1)}…`;
}

/** "a/b/c" → "c" */
function leaf(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

/** "https://host/path?x" → "host/path" for the sentence. */
function site(url: string, st: St): string {
  return clip(url.trim().replace(/^https?:\/\//, ""), st);
}

/* Tool names engines actually send, by verb. Unlisted tools fall through to
   `Use <pretty name>?` — a name with underscores is still readable. */
const EDIT = [
  "patch",
  "edit",
  "apply_patch",
  "edit_file",
  "str_replace",
  "update_file",
];
const WRITE = ["write_file", "write", "create_file"];
const READ = ["read_file", "read", "open_file"];
const DELETE = ["delete_files", "delete_file", "remove_files", "remove_file"];
const RUN = [
  "terminal",
  "bash",
  "shell",
  "run_command",
  "exec",
  "run",
  "execute",
];
const FETCH = ["fetch", "web_fetch", "fetch_url", "download"];
const LIST = ["list_files", "list_dir", "ls", "glob"];
const SEARCH = ["search_files", "search", "grep", "find_files"];

function pathArg(args: Record<string, unknown>): string | undefined {
  const p =
    args.path ?? args.file ?? args.file_path ?? args.filename ?? args.target;
  return typeof p === "string" && p ? p : undefined;
}

/** `mcp__<server>__<method>` — hyphenated servers count, and the tool name
    alone (no JSON args) still parses. */
const MCP_NAME = /^mcp__([\w-]+)__(.+)$/;

function mcpSentence(tool: string): string | undefined {
  const m = MCP_NAME.exec(tool);
  if (!m) return undefined;
  return `Use ${m[1].replace(/[-_]/g, " ")}'s ${m[2].replace(/_/g, " ")}`;
}

/* apply_patch bodies mark each file with `*** Add/Update/Delete File: <path>`.
   A patch that only deletes must ask "Delete …?", never "Edit …". */
const PATCH_MARK = /\*\*\* (Add|Update|Delete) File:\s*(\S+)/g;

function patchDeletes(args: Record<string, unknown>): string[] | undefined {
  for (const v of Object.values(args)) {
    if (typeof v !== "string" || !v.includes("*** ")) continue;
    const marks = [...v.matchAll(PATCH_MARK)];
    if (marks.length === 0) continue;
    if (marks.some((m) => m[1] !== "Delete")) return undefined;
    return marks.map((m) => m[2]);
  }
  return undefined;
}

/** The verb phrase for a named tool + its JSON args, without "?". */
function toolLine(
  tool: string,
  args: Record<string, unknown> | undefined,
  cwd: string | undefined,
  st: St,
): string {
  const mcp = mcpSentence(tool);
  if (mcp) return mcp;
  const path = args && pathArg(args);
  const files =
    args && Array.isArray(args.paths) ? (args.paths as unknown[]) : undefined;
  const cmd =
    args && typeof args.command === "string" ? args.command : undefined;
  const url = args && typeof args.url === "string" ? args.url : undefined;
  const where = cwd ? ` in ${leaf(cwd)}` : "";
  if (EDIT.includes(tool)) {
    /* A patch that only deletes is a delete — the headline must not claim
       an edit (the body sits in Details either way). */
    const deleted = args && patchDeletes(args);
    if (deleted?.length === 1) return `Delete ${clip(deleted[0], st)}`;
    if (deleted) return `Delete ${deleted.length} files`;
    return `Edit ${clip(path ?? "a file", st)}`;
  }
  if (WRITE.includes(tool)) return `Write ${clip(path ?? "a new file", st)}`;
  if (READ.includes(tool)) return `Read ${clip(path ?? "a file", st)}`;
  if (DELETE.includes(tool)) {
    if (files) {
      if (files.length === 1)
        return `Delete ${clip(typeof files[0] === "string" ? files[0] : "1 file", st)}`;
      return `Delete ${files.length} files`;
    }
    return `Delete ${clip(path ?? "a file", st)}`;
  }
  if (RUN.includes(tool))
    return cmd ? `Run \`${clip(cmd, st)}\`${where}` : "Run a command";
  if (FETCH.includes(tool))
    return url || path
      ? `Fetch ${site(url ?? path ?? "", st)}`
      : "Fetch a page";
  if (LIST.includes(tool)) return `List ${clip(path ?? "files", st)}`;
  if (SEARCH.includes(tool)) {
    const q = args && (args.pattern ?? args.query ?? args.regex);
    return `Search for ${clip(typeof q === "string" ? q : "files", st)}`;
  }
  /* Any tool that names a command still reads as "Run". */
  if (cmd) return `Run \`${clip(cmd, st)}\`${where}`;
  if (path) return `Change ${clip(path, st)}`;
  return `Use ${tool.replace(/_/g, " ")}`;
}

/* ACP-style requests can carry prose instead of "tool {json}" — a tool title
   like "Edit README.md", or a gateway ask written for a person. When the
   first word already is a verb the sentence is ready; a recognised program
   name (or shell syntax) is a command and gets "Run `…`?"; everything else
   is prose and keeps its own words — and its own closing punctuation. */
const VERBS = new Set([
  "edit",
  "write",
  "read",
  "delete",
  "remove",
  "run",
  "execute",
  "fetch",
  "search",
  "find",
  "create",
  "update",
  "list",
  "move",
  "rename",
  "install",
  "apply",
  "open",
  "download",
  "upload",
  "send",
  "call",
  "use",
  "add",
  "change",
  "allow",
  "approve",
  "check",
  "build",
  "test",
  "deploy",
]);

/* Program names a bare command can start with — kept small on purpose: an
   unknown first word followed by ordinary words reads as prose instead. */
const PROGRAMS = new Set([
  "git",
  "gh",
  "npm",
  "npx",
  "bun",
  "bunx",
  "pnpm",
  "yarn",
  "node",
  "deno",
  "python",
  "python3",
  "pip",
  "pip3",
  "uv",
  "cargo",
  "rustc",
  "go",
  "java",
  "mvn",
  "gradle",
  "make",
  "cmake",
  "gcc",
  "clang",
  "swift",
  "swiftc",
  "xcodebuild",
  "docker",
  "kubectl",
  "helm",
  "terraform",
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "tar",
  "unzip",
  "zip",
  "cd",
  "ls",
  "rm",
  "mv",
  "cp",
  "mkdir",
  "rmdir",
  "touch",
  "cat",
  "echo",
  "printf",
  "chmod",
  "chown",
  "sudo",
  "kill",
  "pkill",
  "ps",
  "open",
  "grep",
  "rg",
  "find",
  "sed",
  "awk",
  "diff",
  "patch",
  "sort",
  "head",
  "tail",
  "wc",
  "sleep",
  "env",
  "source",
  "which",
  "brew",
  "apt",
  "apt-get",
  "systemctl",
  "vitest",
  "jest",
  "playwright",
  "pytest",
  "ruff",
  "eslint",
  "biome",
  "tsc",
  "tsx",
  "esbuild",
  "vite",
  "turbo",
  "vercel",
  "wrangler",
  "supabase",
  "gcloud",
  "aws",
  "az",
  "rails",
  "rake",
  "bundle",
  "gem",
  "composer",
  "php",
  "mysql",
  "psql",
  "sqlite3",
  "redis-cli",
  "jq",
  "yq",
  "ffmpeg",
  "sh",
  "bash",
  "zsh",
  "dash",
  "xargs",
  "tee",
  "nix",
  "nix-shell",
  "nixos-rebuild",
]);

/** Does `text` start like a command-line invocation? */
function looksLikeCommand(text: string, first: string): boolean {
  if (!text.includes(" ")) return true;
  if (PROGRAMS.has(first)) return true;
  /* `tool --flag`, `prog=/path`, pipes and redirects. `$` is left out on
     purpose — "Spend $40" is prose, not a variable. */
  return (
    /^[a-z][a-z0-9_.-]*$/.test(first) &&
    /^[-|&;><="'~/]/.test(text.slice(first.length).trimStart())
  );
}

/* Reasons the headline alone is not enough: it clipped, or the payload can
   do harm a sentence cannot show (`rm`, `sudo`, `| sh`, `curl … |`, `>`
   redirects, a path outside the thread folder). The check runs on the FULL
   text, not the clipped sentence — a hidden tail is exactly the case. */
const DANGER: [RegExp, string][] = [
  [/\brm\b/, "rm"],
  [/\bsudo\b/, "sudo"],
  [/\|\s*(?:sudo\s+)?(?:ba|z|da|fi)?sh\b/, "| sh"],
  [/curl[^|\n]*\|/, "curl |"],
  /* `>` / `>>` to a file — `2>&1` is a stream merge, not a write. */
  [/(?:^|\s)\d?>{1,2}\s*(?![=>&])\S/, "redirect"],
  /* lone `&` backgrounds the job — `&&` and `>&` are sequencing/merges. */
  [/(?:^|[^&>])&(?![&\d])/, "background &"],
];

function outsideCwd(text: string, cwd: string, home?: string): boolean {
  const base = cwd.replace(/\/+$/, "");
  for (const m of text.matchAll(/(?:^|[\s"'])((?:\/|~\/)[^\s"')]+)/g)) {
    let p = m[1];
    if (p.startsWith("~")) {
      if (home === undefined) return true;
      p = home.replace(/\/+$/, "") + p.slice(1);
    }
    if (p !== base && !p.startsWith(`${base}/`)) return true;
  }
  return false;
}

function dangerous(text: string, cwd?: string, home?: string): boolean {
  const noUrl = text.replace(/https?:\/\/\S+/g, "");
  if (DANGER.some(([re]) => re.test(noUrl))) return true;
  return cwd !== undefined && outsideCwd(noUrl, cwd, home);
}

/** The first sentence of a prose block, the way the Needs page titles it. */
function firstSentence(desc: string, st: St): { title: string; rest: string } {
  const line = desc.split("\n")[0].trim();
  const end = /[.!?](?=\s|$)/.exec(line);
  const first = end ? line.slice(0, end.index + 1) : line;
  return { title: clip(first, st), rest: desc.slice(first.length).trim() };
}

/** The shape every surface renders: one question plus everything behind it. */
export interface ApprovalSummary {
  /** The plain sentence — the card headline, the Home/Needs question. */
  headline: string;
  /** A second line worth showing (a real description), else absent. */
  note?: string;
  /** The full payload for the Details disclosure — raw command, args and
      prose, unclipped and multi-line. Absent only when there is nothing
      more than the headline itself. */
  details?: string;
  /** Details starts open when the headline clipped or the payload is risky. */
  detailsOpen: boolean;
}

/**
 * One call, one shape: card, Home, Needs and the thread list all read the
 * question from this. `command` is the engine's `request.command` verbatim;
 * `requestId` marks a `gw-` ask whose `description` is the sentence written
 * for the owner; `details` is the raw args payload an adapter attaches when
 * `command` is only a title (ACP `rawInput`); `cwd` is the session folder.
 * The fallback — "<agent> wants to use <tool>" plus Details — guarantees a
 * headline that is never empty and never raw JSON.
 */
export function summariseApproval(input: {
  command: string;
  requestId?: string;
  description?: string;
  details?: string;
  cwd?: string;
  home?: string;
  agent?: string;
}): ApprovalSummary {
  const st: St = { clipped: false };
  const command = input.command.trim();
  const desc = input.description?.trim() ?? "";
  const raw = input.details?.trim() ?? "";
  const agent = input.agent?.trim() || "The agent";

  const fallback = (tool?: string): ApprovalSummary => ({
    headline: `${agent} wants to use ${tool?.replace(/_/g, " ") || "a tool"}`,
    details: [desc, command, raw].filter(Boolean).join("\n\n") || undefined,
    detailsOpen: true,
  });

  let headline = "";
  let note: string | undefined;
  let clipped = false;

  /* A gateway `gw-` ask's description is prose written for the owner — it is
     the question; the command behind it is tool syntax with internal ids. */
  if (input.requestId?.startsWith("gw-") && desc) {
    const { title, rest } = firstSentence(desc, st);
    headline = title;
    note = rest || undefined;
    clipped = st.clipped || desc.length > 80;
  } else if (command === "" || command === "command") {
    /* Empty, or Hermes' literal placeholder `command` — the description or
       the raw args say what this actually is; without either, the honest
       question is "a command". */
    if (desc) {
      headline = clip(firstSentence(desc, st).title, st);
      note = desc === headline ? undefined : desc;
    } else if (raw) {
      try {
        const j = JSON.parse(raw) as Record<string, unknown>;
        headline = `${toolLine("run", j, input.cwd, st)}?`;
      } catch {
        return fallback();
      }
    } else {
      headline = "Run a command?";
    }
  } else {
    const json = /^(\S+)\s+(\{.*\})$/s.exec(command);
    if (json) {
      try {
        headline = `${toolLine(json[1], JSON.parse(json[2]), input.cwd, st)}?`;
      } catch {
        /* args weren't JSON — fall through to the text rule */
      }
    }
    if (headline === "" && command.startsWith("{")) {
      try {
        const args = JSON.parse(command) as Record<string, unknown>;
        const cmd = typeof args.command === "string" ? args.command : undefined;
        const url = typeof args.url === "string" ? args.url : undefined;
        const p = pathArg(args);
        if (cmd)
          headline = `Run \`${clip(cmd, st)}\`${input.cwd ? ` in ${leaf(input.cwd)}` : ""}?`;
        else if (url) headline = `Fetch ${site(url, st)}?`;
        else if (p) headline = `Change ${clip(p, st)}?`;
        else return fallback();
      } catch {
        /* not JSON either */
      }
    }
    if (headline === "") {
      const mcp = mcpSentence(command);
      if (mcp) headline = `${mcp}?`;
    }
    if (headline === "" && !command.includes(" ") && !command.endsWith("?")) {
      /* One bare token: a program ("rm", "ls") runs; a tool name
         ("Terminal", "Task") is a title, not a command. */
      const first = command.toLowerCase();
      if (PROGRAMS.has(first)) headline = `Run \`${command}\`?`;
      else headline = `Use ${command.replace(/_/g, " ")}?`;
      /* A generic title plus a raw args payload — prefer the payload's own
         command when it names one ("Terminal" + {command:"bun x"}). */
      if (!PROGRAMS.has(first) && raw) {
        try {
          const j = JSON.parse(raw) as Record<string, unknown>;
          if (typeof j.command === "string" && j.command)
            headline = `Run \`${clip(j.command, st)}\`${input.cwd ? ` in ${leaf(input.cwd)}` : ""}?`;
        } catch {
          /* details weren't JSON — the title stands */
        }
      }
    }
    if (headline === "") {
      const first = command.split(/\s/, 1)[0].toLowerCase();
      /* Text already ending in "?" is a question, never a command. */
      if (
        !command.endsWith("?") &&
        !VERBS.has(first) &&
        looksLikeCommand(command, first)
      ) {
        headline = `Run \`${clip(command, st)}\`${input.cwd ? ` in ${leaf(input.cwd)}` : ""}?`;
      } else {
        /* Prose keeps its own words and its own ending: a "?" stays a "?",
           a "." stays a "." — only unpunctuated prose gains the "?". */
        headline = /[.?!]\s*$/.test(command)
          ? clip(command, st)
          : `${clip(command.replace(/[.!\s]+$/, ""), st)}?`;
      }
    }
  }

  /* The note: a description that adds words beyond the question. Echoes of
     the ask itself ("patch wants to run: patch {…}") drop out. */
  if (note === undefined && desc) {
    const stripped = desc.replace(/^\S+\s+wants to run:\s*/i, "").trim();
    if (stripped && stripped !== command) note = desc;
  }

  /* Details: everything the engine sent — description, the raw command with
     its args, the adapter's rawInput payload — unclipped, multi-line. */
  const parts = [desc, command !== "command" ? command : "", raw].filter(
    (x) => x !== "",
  );
  const details =
    parts.length && parts.join(" ") !== headline
      ? parts.join("\n\n")
      : undefined;

  return {
    headline: headline === "" ? `${agent} wants to use a tool` : headline,
    note,
    details,
    detailsOpen:
      clipped ||
      st.clipped ||
      (details !== undefined && dangerous(details, input.cwd, input.home)),
  };
}

/**
 * The one question for an approval: `<engine command>` → a sentence ending
 * in "?". `cwd` is the folder the session works in; when given, a run step
 * says where ("Run `x` in lilos?").
 */
export function summariseAsk(command: string, cwd?: string): string {
  return summariseApproval({ command, cwd }).headline;
}

/**
 * Engine descriptions often just echo the ask ("patch wants to run: patch
 * {…}"). Returns the part of `note` worth showing under the sentence, or
 * undefined when it only repeats the command.
 */
export function askNote(command: string, note?: string): string | undefined {
  const n = note?.trim();
  if (!n) return undefined;
  const stripped = n.replace(/^\S+\s+wants to run:\s*/i, "").trim();
  if (!stripped || stripped === command.trim()) return undefined;
  return n;
}
