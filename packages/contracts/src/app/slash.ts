/**
 * The composer's `/` send shape — a command name at the very start of the
 * text plus the rest verbatim as args. The menu's pick inserts this shape
 * and every send-side route (engine exec, app-owned commands) keys off this
 * one parse. `/` mid-text, `/path/to/a/file`, or a bare `/` is plain text.
 */
export function parseSlashCommand(
  text: string,
): { name: string; args: string } | null {
  const m = /^\/([A-Za-z][\w.-]*)(?:[ \t]+([\s\S]*))?$/.exec(text);
  if (!m?.[1]) return null;
  return { name: m[1].toLowerCase(), args: m[2]?.trim() ?? "" };
}

/** True when the draft is in "slash menu" position: `/…` starting at
    character 0 with no space yet — the fragment the menu filters on. */
export function slashQuery(text: string): string | null {
  const m = /^\/([\w.-]*)$/.exec(text);
  return m ? (m[1] ?? "") : null;
}
