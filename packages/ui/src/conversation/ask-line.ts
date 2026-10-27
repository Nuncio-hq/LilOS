/**
 * #884: one plain sentence for an approval request — "Edit README.md?",
 * "Run `bun run verify` in lilos?". Every surface that asks for a decision
 * (the thread card, Home's needs-you row, the Needs page) renders this, so
 * the question reads the same everywhere and nobody sees raw JSON.
 */

/** How long an embedded name/path/command may run before it truncates. */
const MAX_TARGET = 72;

function clip(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > MAX_TARGET ? `${t.slice(0, MAX_TARGET - 1)}…` : t;
}

/** "a/b/c" → "c" */
function leaf(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

/** "https://host/path?x" → "host/path" for the sentence. */
function site(url: string): string {
  return clip(url.trim().replace(/^https?:\/\//, ""));
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
  const p = args.path ?? args.file ?? args.filename ?? args.target;
  return typeof p === "string" && p ? p : undefined;
}

/** The verb phrase for a named tool + its JSON args, without "?". */
function toolLine(
  tool: string,
  args: Record<string, unknown> | undefined,
  cwd?: string,
): string {
  const mcp = /^mcp__(\w+)__(.+)$/.exec(tool);
  if (mcp) return `Use ${mcp[1]}'s ${mcp[2].replace(/_/g, " ")}`;
  const path = args && pathArg(args);
  const files =
    args && Array.isArray(args.paths) ? (args.paths as unknown[]) : undefined;
  const cmd =
    args && typeof args.command === "string" ? args.command : undefined;
  const url = args && typeof args.url === "string" ? args.url : undefined;
  const where = cwd ? ` in ${leaf(cwd)}` : "";
  if (EDIT.includes(tool)) return `Edit ${clip(path ?? "a file")}`;
  if (WRITE.includes(tool)) return `Write ${clip(path ?? "a new file")}`;
  if (READ.includes(tool)) return `Read ${clip(path ?? "a file")}`;
  if (DELETE.includes(tool)) {
    if (files) {
      if (files.length === 1)
        return `Delete ${clip(typeof files[0] === "string" ? files[0] : "1 file")}`;
      return `Delete ${files.length} files`;
    }
    return `Delete ${clip(path ?? "a file")}`;
  }
  if (RUN.includes(tool)) return `Run \`${clip(cmd ?? tool)}\`${where}`;
  if (FETCH.includes(tool)) return `Fetch ${site(url ?? path ?? "")}`;
  if (LIST.includes(tool)) return `List ${clip(path ?? "files")}`;
  if (SEARCH.includes(tool)) {
    const q = args && (args.pattern ?? args.query ?? args.regex);
    return `Search for ${clip(typeof q === "string" ? q : "files")}`;
  }
  /* Any tool that names a command still reads as "Run". */
  if (cmd) return `Run \`${clip(cmd)}\`${where}`;
  if (path) return `Change ${clip(path)}`;
  return `Use ${tool.replace(/_/g, " ")}`;
}

/* ACP-style requests can carry prose instead of "tool {json}" — a tool title
   like "Edit README.md", or a gateway ask written for a person. When the
   first word already is a verb the sentence is ready; a recognised program
   name (or shell syntax) is a command and gets "Run `…`?"; everything else
   is prose and keeps its own words. */
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

/**
 * The one question for an approval: `<engine command>` → a sentence ending
 * in "?". `cwd` is the folder the session works in; when given, a run step
 * says where ("Run `x` in lilos?").
 */
export function summariseAsk(command: string, cwd?: string): string {
  const text = command.trim();
  if (!text) return "Approve this step?";
  const json = /^(\S+)\s+(\{.*\})$/s.exec(text);
  if (json) {
    try {
      return `${toolLine(json[1], JSON.parse(json[2]), cwd)}?`;
    } catch {
      /* args weren't JSON — fall through to the text rule */
    }
  }
  if (text.startsWith("{")) {
    try {
      const args = JSON.parse(text);
      if (typeof args?.command === "string")
        return `Run \`${clip(args.command)}\`${cwd ? ` in ${leaf(cwd)}` : ""}?`;
      const p = pathArg(args);
      if (p) return `Change ${clip(p)}?`;
    } catch {
      /* not JSON either */
    }
  }
  const first = text.split(/\s/, 1)[0].toLowerCase();
  if (!VERBS.has(first) && looksLikeCommand(text, first))
    return `Run \`${clip(text)}\`${cwd ? ` in ${leaf(cwd)}` : ""}?`;
  if (text.endsWith("?")) return clip(text);
  return `${clip(text.replace(/[.!\s]+$/, ""))}?`;
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
