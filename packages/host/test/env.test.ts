import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/exec";
import { callHost } from "../src/index";

/**
 * Issue #507 — host execs must run with the allow-listed env only.
 * AC-1: a spawned child sees only the documented LILOS_* names
 * (LILOS_SURFACES_URL + LILOS_ENGINE_TOKEN) — never LILOS_RELAY_TOKEN,
 * LILOS_*_HOME or LILOS_WORKDIR, even though the harness process itself
 * carries them. The two seams an agent can reach from a folder session are
 * exercised for real: a `git` shim early on PATH (the direct exec child) and
 * a hook planted in the session repo (the grandchild behind `git commit`).
 */

const POISON = [
  "LILOS_RELAY_TOKEN",
  "LILOS_RELAY_HOME",
  "LILOS_HARNESS_HOME",
  "LILOS_WORKDIR",
  "LILOS_INTERNAL_MARKER",
];
/* The documented pair every spawned process may see (#412's allow-list). */
const GRANTED = {
  LILOS_SURFACES_URL: "http://127.0.0.1:9/gw",
  LILOS_ENGINE_TOKEN: "eng-token",
};

let root = "";
let prevEnv: Record<string, string | undefined> = {};

const lilosLines = (dump: string) =>
  dump
    .split("\n")
    .filter((l) => l.startsWith("LILOS_"))
    .sort();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lilos507-"));
  prevEnv = Object.fromEntries(
    [...POISON, ...Object.keys(GRANTED)].map((k) => [k, process.env[k]]),
  );
  process.env.LILOS_RELAY_TOKEN = "relay-secret";
  process.env.LILOS_RELAY_HOME = "/lilos/relay";
  process.env.LILOS_HARNESS_HOME = "/lilos/harness";
  process.env.LILOS_WORKDIR = "/lilos/harness/work";
  process.env.LILOS_INTERNAL_MARKER = "not-for-agents";
  for (const [k, v] of Object.entries(GRANTED)) process.env[k] = v;
});

afterAll(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("AC-1 (#507) host exec children see only the allow-listed LILOS_* env", () => {
  it("a spawned child sees only the documented names", async () => {
    const dir = join(root, "shim");
    mkdirSync(dir);
    const dump = join(dir, "env.txt");
    const shim = join(dir, "git");
    /* A `git` shim ahead of PATH — the same position an agent-owned dir
       could hold — records the env every host git call hands its child. */
    writeFileSync(shim, `#!/bin/sh\nenv > "${dump}"\nexit 0\n`);
    chmodSync(shim, 0o755);
    const prevPath = process.env.PATH;
    process.env.PATH = `${dir}:${prevPath}`;
    try {
      await callHost("git.isRepo", { path: dir });
    } finally {
      process.env.PATH = prevPath;
    }
    const seen = lilosLines(readFileSync(dump, "utf8"));
    expect(seen).toEqual([
      "LILOS_ENGINE_TOKEN=eng-token",
      "LILOS_SURFACES_URL=http://127.0.0.1:9/gw",
    ]);
  });

  it("a repo hook planted in the session folder cannot recover LILOS_* internals", async () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git(["init", "-b", "trunk"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "one\n");
    const dump = join(root, "hook-env.txt");
    /* The #507 attack: agent-writable `.git/hooks/*` runs inside the
       workbench git op's environment — today it reads LILOS_RELAY_TOKEN. */
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(
      join(repo, ".git", "hooks", "post-commit"),
      `#!/bin/sh\nenv > "${dump}"\n`,
    );
    chmodSync(join(repo, ".git", "hooks", "post-commit"), 0o755);

    await callHost("git.commit", {
      path: repo,
      files: ["f.txt"],
      message: "x",
    });

    const seen = lilosLines(readFileSync(dump, "utf8"));
    expect(seen).toEqual([
      "LILOS_ENGINE_TOKEN=eng-token",
      "LILOS_SURFACES_URL=http://127.0.0.1:9/gw",
    ]);
  });

  it("a caller-supplied env is an explicit grant, not a leak", async () => {
    /* Same contract as the launcher's options.env (#505): a LILOS_* name a
       caller deliberately forwards keeps working — the checkpoint shadow
       store passes GIT_* this way. */
    const { stdout } = await run("env", [], {
      env: { LILOS_FUTURE_KNOB: "granted" },
    });
    expect(lilosLines(stdout)).toEqual([
      "LILOS_ENGINE_TOKEN=eng-token",
      "LILOS_FUTURE_KNOB=granted",
      "LILOS_SURFACES_URL=http://127.0.0.1:9/gw",
    ]);
  });
});
