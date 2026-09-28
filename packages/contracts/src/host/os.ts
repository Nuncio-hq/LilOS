import { z } from "zod";

/**
 * OS surface of the host API (issue #110): open paths from a session's
 * folder in a desktop editor, or reveal them in Finder. Everything runs on
 * the machine the host runs on — paths arrive under a caller-given `root`
 * (the session's folder) and never leave it, and launches go through
 * argv-only exec, never a shell.
 */

const Path = z.string().min(1);

/** Editors LilOS knows how to open, in default-preference order — the first
 *  one found on the machine is the default until a settings picker lands
 *  (#132). */
export const OS_EDITOR_IDS = ["vscode", "cursor", "zed", "xcode"] as const;
export const OsEditorId = z.enum(OS_EDITOR_IDS);
export type OsEditorId = z.infer<typeof OsEditorId>;

/** One editor detected on the host machine. */
export const OsEditor = z.object({
  id: OsEditorId,
  /** Display name, e.g. "VS Code". */
  name: z.string().min(1),
  /** The `.app` bundle the editor was found in (`/Applications/...`). */
  app: z.string().min(1),
});
export type OsEditor = z.infer<typeof OsEditor>;

// ── os.editors ──────────────────────────────────────────────────────────────
export const OsEditorsParams = z.strictObject({});
export type OsEditorsParams = z.infer<typeof OsEditorsParams>;
export const OsEditorsResult = z.object({
  /** Detected editors, in OS_EDITOR_IDS order (first = default). */
  editors: z.array(OsEditor),
});
export type OsEditorsResult = z.infer<typeof OsEditorsResult>;

// ── os.open ─────────────────────────────────────────────────────────────────
/** What to open with: an editor id, or "finder" to reveal in Finder. */
export const OsOpenApp = z.enum([...OS_EDITOR_IDS, "finder"]);
export type OsOpenApp = z.infer<typeof OsOpenApp>;

export const OsOpenParams = z.strictObject({
  /** The session's folder; `path` must resolve inside it (realpath-checked). */
  root: Path,
  /** Path to open — relative to `root`, or absolute under it; `"."` = the folder itself. */
  path: Path,
  app: OsOpenApp,
  /** 1-based line to open at; honoured by VS Code / Cursor / Zed only. */
  line: z.int().min(1).optional(),
});
export type OsOpenParams = z.infer<typeof OsOpenParams>;
export const OsOpenResult = z.object({});
export type OsOpenResult = z.infer<typeof OsOpenResult>;
