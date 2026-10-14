import { z } from "zod";

/**
 * `commands` capability — the slash menu: the engine offers named commands and
 * skills the composer can list, filter, and run in the session like the TUI's
 * `/` palette. Engines without it declare nothing and the composer keeps `/`
 * as plain text.
 */
export const CommandKind = z.enum(["command", "skill"]);
export type CommandKind = z.infer<typeof CommandKind>;

export const CommandItem = z.object({
  /** Name as typed after `/` (no leading slash). */
  name: z.string().min(1),
  /** One-line description shown under the name. */
  description: z.string().default(""),
  /** `command` runs engine-side; `skill` injects its template as the prompt. */
  kind: CommandKind,
  /** Hint for expected args, e.g. `[branch]` — shown greyed after the name. */
  argsHint: z.string().optional(),
  /** Engine-owned extras (bundle, source file, plugin name, ...). */
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type CommandItem = z.infer<typeof CommandItem>;

export const CommandsListParams = z.object({
  /** Session the menu is for; omitted = the engine's profile-level list. */
  sessionId: z.string().optional(),
  /** Filter string as typed after `/` — the engine narrows its list. */
  query: z.string().optional(),
  /** Agent/profile id when listing before a session exists (home composer). */
  agent: z.string().optional(),
  /** Working dir so folder-local skills list before a session exists. */
  cwd: z.string().optional(),
});
export type CommandsListParams = z.infer<typeof CommandsListParams>;

/** Literal spec shape: the list itself is the result (see issue text). */
export const CommandsListResult = z.array(CommandItem);
export type CommandsListResult = z.infer<typeof CommandsListResult>;

export const CommandsExecParams = z.object({
  sessionId: z.string().min(1),
  /** Command name as listed (no leading slash). */
  name: z.string().min(1),
  /** Argument text after the name, verbatim. */
  args: z.string().optional(),
});
export type CommandsExecParams = z.infer<typeof CommandsExecParams>;

/**
 * A picked command resolves one of two ways: the engine ran it and produced
 * output to show in the thread, or it expanded into a prompt (skills, bundles)
 * that the harness sends as the session's next turn.
 */
export const CommandsExecResult = z.object({
  outcome: z.enum(["output", "prompt"]),
  /** `outcome: "output"` — text to post as the employee's reply. */
  output: z.string().optional(),
  /** `outcome: "prompt"` — expanded text to run as the turn's prompt. */
  prompt: z.string().optional(),
  /** Optional notice the engine wants displayed (e.g. "no args needed"). */
  notice: z.string().optional(),
});
export type CommandsExecResult = z.infer<typeof CommandsExecResult>;
