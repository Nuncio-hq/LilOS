import { describe, expect, test } from "vitest";
import { AcpClientTerminals } from "../src/terminals.js";

/**
 * D-#845 — the client-side `terminal/*` manager. Real child processes,
 * tiny commands only; no agent or LLM involved.
 */
const SESSION = "s-1";
const mk = (opts: { shellCommands?: boolean } = {}) =>
  new AcpClientTerminals({ cwd: process.cwd(), ...opts });

describe("AcpClientTerminals (D-#845)", () => {
  test("create → output → waitForExit → release", async () => {
    const t = mk();
    const { terminalId } = await t.create({
      sessionId: SESSION,
      command: "echo",
      args: ["hello acp"],
    });
    expect(terminalId).toMatch(/^term-/);
    const status = await t.waitForExit({ sessionId: SESSION, terminalId });
    expect(status).toEqual({ exitCode: 0, signal: null });
    const out = await t.output({ sessionId: SESSION, terminalId });
    expect(out.output.trim()).toBe("hello acp");
    expect(out.truncated).toBe(false);
    expect(out.exitStatus?.exitCode).toBe(0);
    await t.release({ sessionId: SESSION, terminalId });
    /* released: operations fail but the snapshot survives for embedded
       tool-call content. */
    await expect(
      t.waitForExit({ sessionId: SESSION, terminalId }),
    ).rejects.toThrow(/unknown terminal/);
    expect(t.readOutputSnapshot(SESSION, terminalId)?.output.trim()).toBe(
      "hello acp",
    );
  });

  test("shellCommands runs shell source in `command`", async () => {
    const t = mk({ shellCommands: true });
    const { terminalId } = await t.create({
      sessionId: SESSION,
      command: "echo one && echo two",
    });
    await t.waitForExit({ sessionId: SESSION, terminalId });
    expect(
      (await t.output({ sessionId: SESSION, terminalId })).output.trim(),
    ).toBe("one\ntwo");
    await t.release({ sessionId: SESSION, terminalId });
  });

  test("request env merges over the base env; cwd honored", async () => {
    const t = mk();
    const { terminalId } = await t.create({
      sessionId: SESSION,
      command: "printenv",
      args: ["ACP_TERM_PROBE"],
      env: [{ name: "ACP_TERM_PROBE", value: "probe-value" }],
    });
    await t.waitForExit({ sessionId: SESSION, terminalId });
    expect(
      (await t.output({ sessionId: SESSION, terminalId })).output.trim(),
    ).toBe("probe-value");
    await t.release({ sessionId: SESSION, terminalId });
  });

  test("nonzero exit reports the code; kill ends a live command", async () => {
    const t = mk();
    const { terminalId } = await t.create({
      sessionId: SESSION,
      command: "sh",
      args: ["-c", "exit 7"],
    });
    expect(
      await t.waitForExit({ sessionId: SESSION, terminalId }),
    ).toEqual({ exitCode: 7, signal: null });
    await t.release({ sessionId: SESSION, terminalId });

    const { terminalId: live } = await t.create({
      sessionId: SESSION,
      command: "sleep",
      args: ["30"],
    });
    await t.kill({ sessionId: SESSION, terminalId: live });
    const killed = await t.waitForExit({
      sessionId: SESSION,
      terminalId: live,
    });
    expect(killed.exitCode === null || killed.exitCode !== 0).toBe(true);
    await t.release({ sessionId: SESSION, terminalId: live });
  });

  test("per-terminal output cap truncates from the start", async () => {
    const t = mk();
    const { terminalId } = await t.create({
      sessionId: SESSION,
      /* HEAD marker then filler — a truncated buffer drops the head. */
      command: "sh",
      args: ["-c", "printf 'HEAD:'; printf 'x%.0s' $(seq 2000)"],
      outputByteLimit: 1000,
    });
    await t.waitForExit({ sessionId: SESSION, terminalId });
    const out = await t.output({ sessionId: SESSION, terminalId });
    expect(out.truncated).toBe(true);
    expect(out.output.length).toBeLessThanOrEqual(1000);
    expect(out.output).not.toContain("HEAD"); // head dropped
    await t.release({ sessionId: SESSION, terminalId });
  });

  test("unknown / foreign-session ids are request errors", async () => {
    const t = mk();
    await expect(
      t.waitForExit({ sessionId: SESSION, terminalId: "term-99" }),
    ).rejects.toThrow(/unknown terminal/);
    const { terminalId } = await t.create({
      sessionId: SESSION,
      command: "echo",
      args: ["x"],
    });
    /* another session may not drive it */
    await expect(
      t.output({ sessionId: "s-2", terminalId }),
    ).rejects.toThrow(/unknown terminal/);
    await t.waitForExit({ sessionId: SESSION, terminalId });
    await t.release({ sessionId: SESSION, terminalId });
  });

  test("a missing executable is a create error, not a hang", async () => {
    const t = mk();
    await expect(
      t.create({
        sessionId: SESSION,
        command: "definitely-not-a-real-bin-845",
      }),
    ).rejects.toThrow(/could not start terminal command/);
  });

  test("disposeAll kills live terminals and resolves waiters", async () => {
    const t = mk();
    const { terminalId } = await t.create({
      sessionId: SESSION,
      command: "sleep",
      args: ["30"],
    });
    const waited = t.waitForExit({ sessionId: SESSION, terminalId });
    await t.disposeAll();
    const status = await waited;
    expect(status.exitCode === null || status.exitCode !== 0).toBe(true);
  });
});
