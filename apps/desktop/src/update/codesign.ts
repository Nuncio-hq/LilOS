import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Signature of a staged or running .app, per `codesign`.
 * `adhoc` = `codesign -s -` dev builds; signed builds carry a TeamIdentifier.
 */
export interface SignatureInfo {
  verified: boolean;
  adhoc: boolean;
  teamId?: string;
}

export async function inspectSignature(
  appPath: string,
): Promise<SignatureInfo> {
  let verified = true;
  try {
    await execFileP("codesign", ["--verify", "--deep", "--strict", appPath]);
  } catch {
    verified = false;
  }
  let info = "";
  try {
    // codesign -dv prints metadata on stderr.
    const { stderr } = await execFileP("codesign", [
      "-dv",
      "--verbose=4",
      appPath,
    ]);
    info = stderr;
  } catch (e) {
    info = String((e as { stderr?: string }).stderr ?? "");
  }
  const teamId = /TeamIdentifier=([A-Z0-9]+)/.exec(info)?.[1];
  const adhoc = /Signature=adhoc/.test(info);
  return { verified, adhoc, teamId };
}

/**
 * Accept/reject a staged bundle before it is ever launched.
 * A real-signed app must never run an unsigned build or another team's
 * build — that path is also how a compromised feed would downgrade us.
 * A dev (ad-hoc) build accepts either kind so local update tests work.
 */
export function signatureBlock(
  current: SignatureInfo,
  staged: SignatureInfo,
): string | undefined {
  if (!staged.verified) return "staged app does not verify";
  if (current.adhoc) return undefined;
  if (staged.adhoc) return "update is unsigned";
  if (staged.teamId !== current.teamId)
    return "update is signed by another team";
  return undefined;
}
