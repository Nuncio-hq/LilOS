import type { HarnessStatusReport } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import type { EngineConnection } from "../src/engine/client";
import { StatusReporter, type SupervisorView } from "../src/status";

const reportStatus = (p: { status?: HarnessStatusReport }) => p.status;

type Sent = {
  engine: { state: string; detail?: string };
  status?: HarnessStatusReport;
};

const fakeConn = (
  describe: () => Promise<unknown>,
): Pick<EngineConnection, "request"> => ({
  request: <T>(method: string) => {
    if (method !== "describe") throw new Error(`unexpected ${method}`);
    return describe() as Promise<T>;
  },
});

const DESCRIBE = {
  name: "engine-fake",
  version: "1.2.3",
  protocol: { name: "lilos-engine", version: 1 },
  capabilities: [],
};

function makeReporter(opts: {
  supervisor: SupervisorView;
  sent?: Sent[];
  readRssBytes?: (pid: number) => number | undefined;
  liveSessions?: () => number;
  logTail?: () => string[];
}) {
  const sent = opts.sent ?? [];
  const reporter = new StatusReporter({
    send: async (params) => {
      sent.push(params as Sent);
      return { ok: true };
    },
    supervisor: opts.supervisor,
    version: "0.1.0",
    model: "fake-model-1",
    liveSessions: opts.liveSessions,
    logTail: opts.logTail,
    readRssBytes: opts.readRssBytes,
    probeTimeoutMs: 500,
  });
  return { reporter, sent };
}

describe("AC-4 (#33) harness status reporter feeds engine RSS + sessions", () => {
  it("reports describe identity, RSS of the supervised pid, and session count", async () => {
    const supervisor: SupervisorView = {
      state: {
        current: "running",
        detail: "engine-fake",
        conn: fakeConn(async () => DESCRIBE) as EngineConnection,
      },
      process: { pid: 4242 },
    };
    const { reporter, sent } = makeReporter({
      supervisor,
      readRssBytes: (pid) => (pid === 4242 ? 84_934_656 : undefined),
      liveSessions: () => 3,
      logTail: () => ["engine spawned", "engine ready"],
    });
    await reporter.reportOnce();

    expect(sent).toHaveLength(1);
    const report = sent[0];
    expect(report.engine).toEqual({ state: "running", detail: "engine-fake" });
    expect(reportStatus(report)?.engineName).toBe("engine-fake");
    expect(reportStatus(report)?.engineVersion).toBe("1.2.3");
    expect(reportStatus(report)?.engineRssBytes).toBe(84_934_656);
    expect(reportStatus(report)?.sessions).toBe(3);
    expect(reportStatus(report)?.model).toBe("fake-model-1");
    expect(reportStatus(report)?.probedAt).toBeGreaterThan(0);
    expect(reportStatus(report)?.logTail).toEqual([
      "engine spawned",
      "engine ready",
    ]);
  });

  it("keeps reporting engine state when the process is down (no pid, no probe)", async () => {
    const supervisor: SupervisorView = {
      state: { current: "failed", detail: "engine exited (code 1)" },
    };
    const { reporter, sent } = makeReporter({ supervisor });
    await reporter.reportOnce();

    const report = sent[0];
    expect(report.engine.state).toBe("failed");
    expect(report.engine.detail).toBe("engine exited (code 1)");
    expect(reportStatus(report)?.engineRssBytes).toBeUndefined();
    expect(reportStatus(report)?.probedAt).toBeUndefined();
    expect(reportStatus(report)?.harnessVersion).toBe("0.1.0");
  });

  it("a failed probe keeps the last good identity but a stale probedAt", async () => {
    let shouldFail = false;
    const supervisor: SupervisorView = {
      state: {
        current: "running",
        conn: fakeConn(async () => {
          if (shouldFail) throw new Error("engine wedged");
          return DESCRIBE;
        }) as EngineConnection,
      },
      process: { pid: 42 },
    };
    const { reporter, sent } = makeReporter({
      supervisor,
      readRssBytes: () => 1024,
    });
    await reporter.reportOnce();
    const firstProbedAt = reportStatus(sent[0])?.probedAt;
    expect(firstProbedAt).toBeGreaterThan(0);

    shouldFail = true;
    await reporter.reportOnce();
    const report = reportStatus(sent[1]);
    expect(report?.engineName).toBe("engine-fake");
    expect(report?.probedAt).toBe(firstProbedAt);
  });

  it("params validate against the wire schema", async () => {
    const supervisor: SupervisorView = {
      state: { current: "stopped" },
    };
    const { reporter, sent } = makeReporter({ supervisor });
    await reporter.reportOnce();
    const parsed =
      // harness.report is host-owned; the wire schema is the source of truth.
      (await import("@lilos/contracts/app")).HarnessReportParams.safeParse(
        sent[0],
      );
    expect(parsed.success).toBe(true);
  });
});
