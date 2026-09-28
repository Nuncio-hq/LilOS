import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { HostUserResult } from "@lilos/contracts/host";

const run = promisify(execFile);

/** The account's display name: macOS `id -F`, else Linux GECOS field 5. */
async function fullName(username: string): Promise<string | null> {
  try {
    const { stdout } = await run("id", ["-F"]);
    const name = stdout.trim();
    if (name) return name;
  } catch {
    // Linux `id` has no -F — fall through to getent.
  }
  try {
    const { stdout } = await run("getent", ["passwd", username]);
    const gecos = stdout.trim().split(":")[4]?.split(",")[0]?.trim();
    if (gecos) return gecos;
  } catch {
    // No NSS lookup available (minimal CI, containers).
  }
  return null;
}

export async function hostUser(): Promise<HostUserResult> {
  const username = os.userInfo().username;
  /* Dev/e2e hook: the name an install would read on the user's machine. */
  const override = process.env.LILOS_USER_NAME?.trim();
  return { username, fullName: override || (await fullName(username)) };
}
