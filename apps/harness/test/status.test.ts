import type {
  HarnessStatusReport,
  ProfileConnection,
} from "@lilos/contracts/app";
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
  connect?: () => ProfileConnection[];
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
    connect: opts.connect,
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

  it("AC-1 (#30) probes models.list only when the engine declares the capability", async () => {
    // Two engines: one declares `models`, one does not. The reporter must
    // attach the catalog (and default) only in the first case — the picker's
    // AC-3 hide relies on these fields being absent otherwise.
    const calls: string[] = [];
    const connFor = (models: boolean) =>
      ({
        request: async <T>(method: string) => {
          calls.push(method);
          if (method === "describe") {
            return {
              ...DESCRIBE,
              capabilities: models ? [{ id: "models", name: "Models" }] : [],
            } as T;
          }
          if (method === "models.list") {
            return {
              models: [
                { id: "fake-small", name: "Fake Small", provider: "fake" },
                { id: "fake-large", name: "Fake Large", provider: "fake" },
              ],
              default: "fake-large",
            } as T;
          }
          throw new Error(`unexpected ${method}`);
        },
      }) as EngineConnection;

    const capable = makeReporter({
      supervisor: { state: { current: "running", conn: connFor(true) } },
      sent: [],
    });
    await capable.reporter.reportOnce();
    const withModels = capable.sent[0].status;
    expect(withModels?.capabilities?.map((c) => c.id)).toContain("models");
    expect(withModels?.models?.map((m) => m.id)).toEqual([
      "fake-small",
      "fake-large",
    ]);
    expect(withModels?.defaultModel).toBe("fake-large");

    calls.length = 0;
    const incapable = makeReporter({
      supervisor: { state: { current: "running", conn: connFor(false) } },
      sent: [],
    });
    await incapable.reporter.reportOnce();
    const without = incapable.sent[0].status;
    expect(without?.models).toBeUndefined();
    expect(without?.defaultModel).toBeUndefined();
    // models.list is never probed for an engine that did not declare `models`.
    expect(calls).toEqual(["describe"]);
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

describe("AC-1 (#413) sendNow re-reports fresh connect rows without probing", () => {
  it("sends the reconciled rows immediately — describe is not re-probed", async () => {
    let probes = 0;
    const supervisor: SupervisorView = {
      state: {
        current: "running",
        detail: "engine-fake",
        conn: {
          request: async <T>(method: string) => {
            probes++;
            if (method === "describe") return DESCRIBE as T;
            throw new Error(`unexpected ${method}`);
          },
        } as EngineConnection,
      },
      process: { pid: 42 },
    };
    let rows: ProfileConnection[] = [
      { profile: "default", employee: "Default", state: "not-connected" },
    ];
    const { reporter, sent } = makeReporter({
      supervisor,
      readRssBytes: () => 1024,
      connect: () => rows,
    });
    await reporter.reportOnce();
    expect(probes).toBe(1);
    expect(sent[0].status?.connect?.[0]?.state).toBe("not-connected");

    // The reconcile flipped the row — sendNow carries it with the cached probe.
    rows = [{ ...rows[0], state: "connected" }];
    await reporter.sendNow();
    expect(sent).toHaveLength(2);
    expect(probes).toBe(1);
    expect(sent[1].status?.connect?.[0]?.state).toBe("connected");
    expect(sent[1].status?.engineName).toBe("engine-fake");
  });
});
