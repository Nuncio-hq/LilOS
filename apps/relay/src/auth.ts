import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Per-install local-process auth (issue #25): the relay generates a token on
 * first run into <homeDir>/relay-token (0600) and local clients pass it in
 * `session.hello`. No user action involved; rotate by deleting the file.
 */
export function loadOrCreateInstallToken(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf8").trim();
    if (token.length > 0) return token;
  }
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, token, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return token;
}
