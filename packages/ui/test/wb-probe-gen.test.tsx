// @vitest-environment happy-dom
/* #814: the git-status generation has to survive the effect restart a
   `running` flip causes. Effect-local counters restart at 0, so an
   older round still in flight and the round that saw the new branch
   compare equal, and the older status lands last. */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { readWbCache } from "../src/lib/wb-probe-cache";
import type { HostAccessors } from "../src/types";
import { useWbProbe } from "../src/workbench/use-wb-probe";

afterEach(cleanup);

type Status = {
  branch: string;
  clean: boolean;
  files: { path: string; status: string }[];
};

describe("#814 probe generation survives an effect restart", () => {
  test("an older git status does not land over the round that saw the new branch", async () => {
    const cwd = "/tmp/wb-gen";
    const gates: { resolve: (v: Status) => void }[] = [];
    const host: HostAccessors = {
      tree: async () => [],
      diff: async () => [],
      read: async () => null,
      pr: async () => ({ pr: null, branch: "trunk" }),
      branches: async () => ({
        current: "trunk",
        branches: ["trunk"],
        remote: null,
        default: "trunk",
      }),
      log: async () => [],
      status: () =>
        new Promise<Status>((resolve) => {
          gates.push({ resolve });
        }),
    };
    const { result, rerender } = renderHook(
      ({ running }: { running: boolean }) =>
        useWbProbe({
          host,
          liveMode: true,
          liveCwd: cwd,
          running,
          tab: "changes",
        }),
      { initialProps: { running: true } },
    );
    await waitFor(() => {
      expect(gates.length).toBeGreaterThanOrEqual(1);
    });
    rerender({ running: false });
    await waitFor(() => {
      expect(gates.length).toBeGreaterThanOrEqual(2);
    });
    const newest = gates.length - 1;
    await act(async () => {
      gates[newest].resolve({
        branch: "feat/e2e-ship",
        clean: true,
        files: [],
      });
    });
    await waitFor(() => {
      expect(result.current.probe?.status?.branch).toBe("feat/e2e-ship");
    });
    await act(async () => {
      for (let i = 0; i < newest; i++) {
        gates[i].resolve({ branch: "trunk", clean: true, files: [] });
      }
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    /* The mounted probe skips a cleaned-up effect's setState. The cache
       does not — that write is what the next mount paints, and it is
       the one the generation has to drop. */
    expect(result.current.probe?.status?.branch).toBe("feat/e2e-ship");
    expect(readWbCache(host, cwd)?.probe.status?.branch).toBe("feat/e2e-ship");
  });
});
