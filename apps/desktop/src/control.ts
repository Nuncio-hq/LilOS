import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ServiceControl, VersionStore } from "@lilos/background";

/** One helper invocation (execFile seam so tests can run on any OS). */
export type HelperExec = (
  bin: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

const realExec: HelperExec = (bin, args) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      const code =
        typeof (error as { code?: unknown })?.code === "number"
          ? ((error as { code: number }).code ?? 1)
          : error
            ? 1
            : 0;
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim() || (error ? error.message : ""),
        code,
      });
    });
  });

/** `lilos-svc status <plist>` prints `<plist> status=<name>`. */
export function parseHelperStatus(stdout: string): string | undefined {
  const match = /status=([A-Za-z()0-9]+)/.exec(stdout);
  return match?.[1];
}

/**
 * ServiceControl on top of the bundled `lilos-svc` binary (SMAppService).
 * `register`/`unregister` throw on failure — ensureLaunchAgents records the
 * per-agent error and never pins a version on failure.
 */
export function helperServiceControl(
  helperPath: string,
  exec: HelperExec = realExec,
): ServiceControl {
  const run = async (
    verb: "status" | "register" | "unregister" | "spawned" | "bootout",
    plist: string,
  ) => {
    const res = await exec(helperPath, [verb, plist]);
    return { ...res, status: parseHelperStatus(res.stdout) };
  };
  return {
    async status(plist) {
      const res = await run("status", plist);
      if (res.code !== 0) {
        throw new Error(
          `lilos-svc status ${plist}: ${res.stderr || res.stdout}`,
        );
      }
      if (!res.status) {
        throw new Error(
          `lilos-svc status ${plist}: unparsable "${res.stdout}"`,
        );
      }
      return res.status;
    },
    async register(plist) {
      const res = await run("register", plist);
      if (res.code !== 0) {
        throw new Error(
          `lilos-svc register ${plist}: ${res.stderr || res.stdout}`,
        );
      }
    },
    async unregister(plist) {
      const res = await run("unregister", plist);
      if (res.code !== 0) {
        throw new Error(
          `lilos-svc unregister ${plist}: ${res.stderr || res.stdout}`,
        );
      }
    },
    async spawned(plist) {
      // Prints `<plist> <job-state>` (state may contain spaces).
      const res = await run("spawned", plist);
      if (res.code !== 0) return "absent";
      return res.stdout.slice(plist.length).trim() || "unknown";
    },
    async bootout(plist) {
      const res = await run("bootout", plist);
      if (res.code !== 0) {
        throw new Error(
          `lilos-svc bootout ${plist}: ${res.stderr || res.stdout}`,
        );
      }
    },
  };
}

/**
 * The bundle version each agent was last registered under, persisted as a
 * `{label: version}` JSON map at `~/Library/Application Support/LilOS/
 * service-version` (per SP1: a version change needs unregister()→register(),
 * so the pin must survive relaunch — and must be per agent so a failing agent
 * is retried without churning the healthy ones).
 */
export function diskVersionStore(file: string): VersionStore {
  const readAll = (): Record<string, string> => {
    try {
      if (!existsSync(file)) return {};
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  };
  return {
    async read(agent) {
      return readAll()[agent] ?? null;
    },
    async write(agent, version) {
      const all = readAll();
      all[agent] = version;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(all)}\n`);
    },
  };
}
