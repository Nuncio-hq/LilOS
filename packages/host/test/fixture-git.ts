import { execFileSync } from "node:child_process";

/* #787: host test fixtures must not inherit the machine git config. A global
   `commit.gpgsign` runs an SSH signer (`gpg.ssh.program`) on every
   `git commit`, and that child has blocked for seconds to ~25s.
   `execFileSync` holds the worker the whole time, so the timeout fires
   before any assertion. `core.fsmonitor`, hooks and gc are the same class
   of work these tests never assert.
   Product git (`packages/host/src/git.ts`) is unchanged and still honours
   the user's signing config. Fixture commands pass the blank config below.
   A test that later commits through the product pins the same keys into
   the repo it created (`pinFixtureRepo`) — that is the environment the
   test sets up, not a product change. `env.test.ts` plants a post-commit
   hook, so it passes `keepHooks` and blanks the process env
   (`isolateFixtureGit`) instead of setting `core.hooksPath`. */

const BASE_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "gc.auto=0",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  "user.email=t@t",
  "-c",
  "user.name=t",
];

export type FixtureGitOptions = {
  /** Leave `core.hooksPath` unset so `.git/hooks` still runs. */
  keepHooks?: boolean;
};

function configArgs(opts?: FixtureGitOptions): string[] {
  if (opts?.keepHooks) return BASE_CONFIG;
  return ["-c", "core.hooksPath=/dev/null", ...BASE_CONFIG];
}

/** Child env for fixture git: no global config, no system config, no prompt. */
export function fixtureGitEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** `git` for a fixture repo. `-c` flags apply to this command only. */
export function fixtureGit(
  cwd: string,
  args: string[],
  opts?: FixtureGitOptions,
): string {
  return execFileSync("git", [...configArgs(opts), ...args], {
    cwd,
    encoding: "utf8",
    env: fixtureGitEnv(),
  });
}

const PINNED: readonly (readonly [string, string])[] = [
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["core.fsmonitor", "false"],
  ["gc.auto", "0"],
];

/** Persist the fixture keys so a later product `git commit` (no `-c`,
    still reading the user's global config) skips the signer. Call after
    `git init`. `keepHooks` does not write `core.hooksPath`. */
export function pinFixtureRepo(cwd: string, opts?: FixtureGitOptions): void {
  const keys: (readonly [string, string])[] = [...PINNED];
  if (!opts?.keepHooks) keys.push(["core.hooksPath", "/dev/null"]);
  for (const [key, value] of keys) {
    fixtureGit(cwd, ["config", key, value], opts);
  }
}

const ISOLATED = [
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_TERMINAL_PROMPT",
] as const;

/** Blank global/system git config on this process. Product spawns inherit
    it (`scrubLilosEnv` keeps non-LILOS_*). Restore so later files in the
    worker still see the machine config. */
export function isolateFixtureGit(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of ISOLATED) saved.set(key, process.env[key]);
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_TERMINAL_PROMPT = "0";
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
