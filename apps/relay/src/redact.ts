/**
 * Diagnostics redaction (issue #33). The single redaction boundary is the
 * relay's `system.status` assembly: own log lines and harness-reported tails
 * are scrubbed here before they leave the process, so a component that logs a
 * secret never leaks it into the bundle the user pastes into a chat.
 */
const SECRET_KEY =
  /token|secret|password|passwd|api[_-]?key|apikey|authorization|credential|private[_-]?key/i;

const PATTERNS: [RegExp, string][] = [
  // key=value / key: value / "key": "value" forms for known secret keys.
  [
    new RegExp(
      `(['"]?(?:${SECRET_KEY.source})['"]?\\s*[:=]\\s*['"]?)[^'"\\s,}\\]]+`,
      "gi",
    ),
    "$1<redacted>",
  ],
  // Authorization headers / bearer strings not covered above.
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>"],
  // Common API key shapes.
  [/\b(?:sk|pk|key|api|tok)-[A-Za-z0-9_-]{8,}/g, "<redacted>"],
  // Long hex blobs — the relay install token is 64 hex chars.
  [/\b[0-9a-f]{40,}\b/gi, "<redacted>"],
];

/**
 * Scrub one log line. `extra` is for secrets whose value is known exactly
 * (e.g. the install token) so any appearance is masked regardless of shape.
 */
export function redactSecrets(
  line: string,
  extra: (string | undefined)[] = [],
): string {
  let out = line;
  for (const secret of extra) {
    if (secret && secret.length >= 8)
      out = out.split(secret).join("<redacted>");
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
