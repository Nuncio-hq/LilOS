import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HermesHostConflict, startHermesServe } from "../src/serve.js";

/**
 * Issue #548 — Hermes's host-backend multiplex.
 *
 * Since the multiplex rework, one `hermes serve` per OS user owns the
 * machine-level backend; a second `serve` attaches to it and exits 0 (or
 * refuses, exit 78, when the asked-for endpoint can't be served by the
 * owner). LilOS must own its backend: the adapter runs `hermes serve`
 * `--isolated` whenever the binary advertises the flag, and the
 * attach/refusal reads as a named conflict — never the retry-able
 * "exited early (code 0)" that used to burn the restart budget.
 */

/** A tiny executable `hermes` that logs every invocation line to calls.log. */
function stubHermes(body: string): { bin: string; calls: string } {
  const dir = mkdtempSync(join(tmpdir(), "lilos-hermes-"));
  const calls = join(dir, "calls.log");
  const bin = join(dir, "hermes");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${calls}"\n${body}\n`);
  chmodSync(bin, 0o755);
  return { bin, calls };
}

const ATTACH = `
echo "Hermes backend already running on this host: PID 96194, port 55066."
echo "  Managing profile 'default': http://127.0.0.1:55066/?profile=default"
exit 0`;

/** `serve --help` answers usage naming --isolated; `serve` then attaches. */
const MULTIPLEX_STUB = `
if [ "$2" = "--help" ]; then
  echo "usage: hermes serve [--port N] [--host H] [--isolated]"
  exit 0
fi
${ATTACH}`;

describe("AC-3 (#548) a multiplex attach is a named conflict, not a retry-able crash", () => {
  it("`serve` printing the attach marker and exiting 0 rejects HermesHostConflict naming the owner", async () => {
    const { bin } = stubHermes(MULTIPLEX_STUB);
    const err = await startHermesServe({ bin }).catch((e) => e);
    expect(err).toBeInstanceOf(HermesHostConflict);
    expect((err as HermesHostConflict).owner).toEqual({
      pid: 96194,
      port: 55066,
    });
    expect(String(err)).toContain("another Hermes backend is already running");
    expect(String(err)).toContain("PID 96194");
    expect(String(err)).toContain("port 55066");
    expect(String(err)).not.toContain("exited early");
  });

  it("the adapter spawns its own backend `--isolated` when the binary advertises it", async () => {
    const { bin, calls } = stubHermes(MULTIPLEX_STUB);
    await startHermesServe({ bin }).catch(() => {});
    const log = readFileSync(calls, "utf8");
    expect(log).toContain("serve --help");
    expect(log).toMatch(
      /serve --host 127\.0\.0\.1 --port 0 --skip-build --isolated/m,
    );
  });

  it("a binary without --isolated still fails named, not 'exited early'", async () => {
    const { bin, calls } = stubHermes(`
if [ "$2" = "--help" ]; then
  echo "usage: hermes serve [--port N] [--host H]"
  exit 0
fi
${ATTACH}`);
    const err = await startHermesServe({ bin }).catch((e) => e);
    expect(err).toBeInstanceOf(HermesHostConflict);
    expect(String(err)).toContain("already running");
    const serveLine = readFileSync(calls, "utf8")
      .split("\n")
      .find((l) => l.startsWith("serve --host"));
    expect(serveLine).not.toContain("--isolated");
  });

  it("an endpoint refusal (exit 78) is the same named conflict", async () => {
    const { bin } = stubHermes(`
if [ "$2" = "--help" ]; then
  echo "usage: hermes serve [--port N] [--host H] [--isolated]"
  exit 0
fi
echo "Refusing to start: this host is already served by hermes serve (pid 7, http://127.0.0.1:9119)."
echo "  You asked for --port 9119 (the host owner is on port 55066)."
exit 78`);
    const err = await startHermesServe({ bin }).catch((e) => e);
    expect(err).toBeInstanceOf(HermesHostConflict);
    expect(String(err)).toContain("refused");
    expect(String(err)).toContain("pid 7");
    expect(String(err)).not.toContain("exited early");
  });

  it("an ordinary early exit still reads 'exited early' (not a conflict)", async () => {
    const { bin } = stubHermes(`echo "boom"; exit 3`);
    const err = await startHermesServe({ bin }).catch((e) => e);
    expect(err).not.toBeInstanceOf(HermesHostConflict);
    expect(String(err)).toContain("exited early (code 3)");
  });

  it("does not pass --isolated twice — or probe — when the caller already passed it", async () => {
    const { bin, calls } = stubHermes(MULTIPLEX_STUB);
    await startHermesServe({ bin, args: ["--isolated"] }).catch(() => {});
    const log = readFileSync(calls, "utf8");
    const serveLine = log.split("\n").find((l) => l.startsWith("serve --host"));
    expect(serveLine?.match(/--isolated/g)).toHaveLength(1);
    expect(log).not.toContain("serve --help");
  });

  it("probes `serve --help` once per binary — a relaunch does not re-probe", async () => {
    const { bin, calls } = stubHermes(MULTIPLEX_STUB);
    await startHermesServe({ bin }).catch(() => {});
    await startHermesServe({ bin }).catch(() => {});
    expect(readFileSync(calls, "utf8").match(/serve --help/g)).toHaveLength(1);
  });
});
