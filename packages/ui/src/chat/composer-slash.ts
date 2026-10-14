/* `/` menu fragment helpers for the composer: the menu opens only while the
 * draft IS a slash fragment — `/token` starting at character 0 with no
 * whitespace yet (typing `/x` filters; once a space lands the command is
 * being argued, not picked). A `/` mid-text or a path like `/tmp/a` never
 * opens it. */

const FRAGMENT = /^\/([\w.-]*)$/;

/** The filter text the draft is, or null when the `/` menu stays closed. */
export function slashQuery(draft: string): string | null {
  const m = FRAGMENT.exec(draft);
  return m ? (m[1] ?? "") : null;
}

/** Insert a picked command: the whole draft becomes `/name ` — the fragment
    spans position 0, so nothing survives before it. */
export function insertSlash(name: string): string {
  return `/${name} `;
}

/** `/name args` out of a finished draft — the shape the send routes on. */
export function parseSlashDraft(
  text: string,
): { name: string; args: string } | null {
  const m = /^\/([A-Za-z][\w.-]*)(?:[ \t]+([\s\S]*))?$/.exec(text);
  if (!m?.[1]) return null;
  return { name: m[1].toLowerCase(), args: m[2]?.trim() ?? "" };
}
