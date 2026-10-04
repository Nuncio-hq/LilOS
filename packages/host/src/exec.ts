import {
  type ExecFileOptionsWithStringEncoding,
  execFile,
} from "node:child_process";
import { promisify } from "node:util";
import { scrubLilosEnv } from "@lilos/contracts/env";

const execFileAsync = promisify(execFile);

/* The one execFile seam for @lilos/host (#507): every host spawn — git ops
   (repo hooks included), gh, open, id/getent, shadow-git — runs with the
   allow-listed env, never the harness's own. An explicit `options.env`
   merges AFTER the scrub, so a deliberate grant (checkpoint GIT_* vars)
   always wins — same contract as the engine launcher's options.env. */
export function run(
  file: string,
  args: string[],
  options?: ExecFileOptionsWithStringEncoding,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, {
    ...options,
    env: { ...scrubLilosEnv(process.env), ...options?.env },
  });
}
