import { type ChildProcess, spawn } from "node:child_process";
import type * as acp from "@agentclientprotocol/sdk";

/**
 * D-#845 — client-side `terminal/*` serving for agents that route shell
 * commands through the ACP client instead of keeping their own tools.
 * Ported from T3 Code's `clientTerminals.ts` (MIT) as plain TS: bounded
 * per-terminal output (truncate from the start at a UTF-8 boundary, per
 * spec), live/unreleased/retained limits so a runaway agent cannot grow
 * memory without bound, and `wait_for_exit`/`kill`/`release` lifecycle.
 * Vendor-free: whether terminals run and whether `command` is shell source
 * arrive as options from the engine package's shim.
 */

const MAX_LIVE_TERMINALS = 16;
const MAX_UNRELEASED_TERMINALS = 64;
const MAX_RETAINED_TERMINALS = 32;
const MAX_RETAINED_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_OUTPUT_BYTE_LIMIT = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTE_LIMIT = 8 * 1024 * 1024;
const FORCE_KILL_AFTER_MS = 5_000;

interface OutputBufferState {
  chunks: Uint8Array[];
  bytes: number;
  truncated: boolean;
  readonly limit: number;
}

function trimOutputStart(state: OutputBufferState, bytes: number): void {
  let remaining = Math.min(bytes, state.bytes);
  while (remaining > 0) {
    const head = state.chunks[0];
    if (head === undefined) break;
    if (head.byteLength <= remaining) {
      state.chunks.shift();
      state.bytes -= head.byteLength;
      remaining -= head.byteLength;
    } else {
      state.chunks[0] = head.subarray(remaining);
      state.bytes -= remaining;
      remaining = 0;
    }
    state.truncated = true;
  }
}

function appendOutput(state: OutputBufferState, chunk: Uint8Array): void {
  state.chunks.push(chunk);
  state.bytes += chunk.byteLength;
  // The spec requires truncation from the beginning of the output.
  if (state.bytes > state.limit)
    trimOutputStart(state, state.bytes - state.limit);
}

function readOutput(state: OutputBufferState): string {
  let combined = Buffer.concat(state.chunks, state.bytes);
  if (state.truncated) {
    // The spec requires truncation at a UTF-8 character boundary.
    let start = 0;
    while (
      start < combined.byteLength &&
      (combined[start]! & 0b1100_0000) === 0b1000_0000
    ) {
      start += 1;
    }
    combined = combined.subarray(start);
  }
  return combined.toString("utf8");
}

interface ManagedTerminal {
  readonly terminalId: string;
  readonly sessionId: string;
  readonly commandLine: string;
  readonly buffer: OutputBufferState;
  readonly proc: ChildProcess;
  readonly exited: Promise<acp.TerminalExitStatus>;
  exitStatus: acp.TerminalExitStatus | undefined;
  released: boolean;
  killTimer?: NodeJS.Timeout;
}

export interface AcpTerminalOutputSnapshot {
  readonly output: string;
  readonly truncated: boolean;
  readonly exitStatus: acp.TerminalExitStatus | undefined;
}

export interface AcpClientTerminalsOptions {
  /** The agent sends shell source in `command` rather than an executable
      plus args — spawn it through the login shell (`shell: true`). */
  shellCommands?: boolean;
  /** Fallback cwd when the request carries none. */
  cwd: string;
  /** Base environment for spawned commands — already scrubbed (D-#412);
      the request's own `env` entries merge over it. */
  env?: NodeJS.ProcessEnv;
  /** SIGKILL lag after SIGTERM on kill/release. */
  forceKillAfterMs?: number;
}

/**
 * The `terminal/*` method handlers `AcpConnection` wires onto the ACP
 * client when the engine advertises `clientCapabilities.terminal`.
 */
export class AcpClientTerminals {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private nextId = 1;
  /** Serialized `terminal/create` — limits check before spawn. */
  private creating: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: AcpClientTerminalsOptions) {}

  create = (
    request: acp.CreateTerminalRequest,
  ): Promise<acp.CreateTerminalResponse> => {
    const run = this.creating.then(() => this.createNow(request));
    this.creating = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  private async createNow(
    request: acp.CreateTerminalRequest,
  ): Promise<acp.CreateTerminalResponse> {
    const all = [...this.terminals.values()];
    const unreleased = all.filter((t) => !t.released).length;
    if (unreleased >= MAX_UNRELEASED_TERMINALS)
      throw new Error(
        `terminal/create exceeded the limit of ${MAX_UNRELEASED_TERMINALS} unreleased terminals`,
      );
    const live = all.filter(
      (t) => !t.released && t.exitStatus === undefined,
    ).length;
    if (live >= MAX_LIVE_TERMINALS)
      throw new Error(
        `terminal/create exceeded the limit of ${MAX_LIVE_TERMINALS} concurrent terminals`,
      );

    const requestEnv = Object.fromEntries(
      (request.env ?? []).map((v) => [v.name, v.value] as const),
    );
    const env =
      this.opts.env === undefined && Object.keys(requestEnv).length === 0
        ? undefined
        : { ...this.opts.env, ...requestEnv };
    const args = request.args ?? [];
    const child = spawn(request.command, args, {
      cwd: request.cwd ?? this.opts.cwd,
      /* Devin-style agents send shell source in `command` — run it through
         the shell only when no argv accompanies it. */
      shell: this.opts.shellCommands === true && args.length === 0,
      ...(env ? { env } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
    } catch (e) {
      throw new Error(
        `could not start terminal command '${request.command}': ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    const terminalId = `term-${this.nextId++}`;
    let settle!: (v: acp.TerminalExitStatus) => void;
    const exited = new Promise<acp.TerminalExitStatus>((r) => {
      settle = r;
    });
    const record: ManagedTerminal = {
      terminalId,
      sessionId: request.sessionId,
      commandLine: [request.command, ...args].join(" "),
      buffer: {
        chunks: [],
        bytes: 0,
        truncated: false,
        limit: Math.min(
          request.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT,
          MAX_OUTPUT_BYTE_LIMIT,
        ),
      },
      proc: child,
      exited,
      exitStatus: undefined,
      released: false,
    };
    this.terminals.set(terminalId, record);

    const pump = (chunk: Uint8Array) => {
      appendOutput(record.buffer, chunk);
      this.enforceTotalOutputLimit();
    };
    child.stdout?.on("data", pump);
    child.stderr?.on("data", pump);
    /* 'close' fires after stdio drained — the exit settles only once every
       byte the command wrote sits in the buffer. */
    child.once("close", (code, signal) => {
      if (record.killTimer) clearTimeout(record.killTimer);
      record.exitStatus = {
        exitCode: code,
        signal: signal ?? null,
      };
      settle(record.exitStatus);
    });
    /* A spawn error after 'spawn' never fires 'close' — settle so
       waitForExit callers do not hang. */
    child.once("error", () => {
      if (record.killTimer) clearTimeout(record.killTimer);
      record.exitStatus ??= { exitCode: null, signal: null };
      settle(record.exitStatus);
    });
    return { terminalId };
  }

  /* All method handlers are async — a bad request rejects the JSON-RPC
     call rather than throwing synchronously into the SDK dispatcher. */
  output = async (
    request: acp.TerminalOutputRequest,
  ): Promise<acp.TerminalOutputResponse> => {
    const t = this.require(request.sessionId, request.terminalId, "output");
    return {
      output: readOutput(t.buffer),
      truncated: t.buffer.truncated,
      ...(t.exitStatus === undefined ? {} : { exitStatus: t.exitStatus }),
    };
  };

  waitForExit = async (
    request: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse> =>
    this.require(request.sessionId, request.terminalId, "wait_for_exit").exited;

  kill = async (
    request: acp.KillTerminalRequest,
  ): Promise<acp.KillTerminalResponse> => {
    const t = this.require(request.sessionId, request.terminalId, "kill");
    this.killProc(t);
    return {};
  };

  release = async (
    request: acp.ReleaseTerminalRequest,
  ): Promise<acp.ReleaseTerminalResponse> => {
    const t = this.require(request.sessionId, request.terminalId, "release");
    t.released = true;
    if (t.exitStatus === undefined) this.killProc(t);
    /* The record stays in the map — tool-call content embedded by
       `terminalId` resolves against the retained output after release. */
    await t.exited;
    this.pruneReleased();
    return {};
  };

  /** Buffered output for embedded tool-call content; survives release. */
  readOutputSnapshot = (
    sessionId: string,
    terminalId: string,
  ): AcpTerminalOutputSnapshot | undefined => {
    const t = this.terminals.get(terminalId);
    if (t === undefined || t.sessionId !== sessionId) return undefined;
    return {
      output: readOutput(t.buffer),
      truncated: t.buffer.truncated,
      exitStatus: t.exitStatus,
    };
  };

  readCommandLine = (terminalId: string): string | undefined =>
    this.terminals.get(terminalId)?.commandLine;

  /** Connection teardown: release everything, kill what is still live. */
  disposeAll = async (): Promise<void> => {
    await Promise.allSettled(
      [...this.terminals.values()].map(async (t) => {
        t.released = true;
        if (t.exitStatus === undefined) this.killProc(t);
        await t.exited;
      }),
    );
    this.pruneReleased();
  };

  private require(
    sessionId: string,
    terminalId: string,
    operation: string,
  ): ManagedTerminal {
    const t = this.terminals.get(terminalId);
    if (t === undefined || t.sessionId !== sessionId || t.released)
      throw new Error(
        `terminal/${operation} received an unknown terminal id '${terminalId}'`,
      );
    return t;
  }

  private killProc(t: ManagedTerminal): void {
    try {
      t.proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    if (!t.killTimer) {
      t.killTimer = setTimeout(() => {
        try {
          t.proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, this.opts.forceKillAfterMs ?? FORCE_KILL_AFTER_MS);
      t.killTimer.unref();
    }
  }

  /** The spec's per-terminal cap can still overrun memory across many
      terminals — trim the oldest bytes globally past the retained cap. */
  private enforceTotalOutputLimit(): void {
    let excess =
      [...this.terminals.values()].reduce((n, t) => n + t.buffer.bytes, 0) -
      MAX_RETAINED_OUTPUT_BYTES;
    if (excess <= 0) return;
    for (const t of this.terminals.values()) {
      const before = t.buffer.bytes;
      trimOutputStart(t.buffer, excess);
      excess -= before - t.buffer.bytes;
      if (excess <= 0) return;
    }
  }

  private pruneReleased(): void {
    const released = [...this.terminals.values()].filter((t) => t.released);
    let retainedBytes = released.reduce((n, t) => n + t.buffer.bytes, 0);
    while (
      released.length > MAX_RETAINED_TERMINALS ||
      retainedBytes > MAX_RETAINED_OUTPUT_BYTES
    ) {
      const t = released.shift();
      if (t === undefined) break;
      retainedBytes -= t.buffer.bytes;
      this.terminals.delete(t.terminalId);
    }
  }
}

/**
 * `tool_call`/`tool_call_update` content can embed `{type:"terminal"}`
 * references — substitute the captured output as a text block so the
 * shared mapping (and the client) see plain content.
 */
export function resolveEmbeddedTerminalContent(
  notification: acp.SessionNotification,
  readOutputSnapshot: AcpClientTerminals["readOutputSnapshot"],
): acp.SessionNotification {
  const update = notification.update;
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  ) {
    return notification;
  }
  const content = update.content;
  if (!content?.some((entry) => entry.type === "terminal")) return notification;
  const mapped = content.map(
    (entry): acp.ToolCallContent =>
      entry.type !== "terminal"
        ? entry
        : {
            type: "content",
            content: {
              type: "text",
              text:
                readOutputSnapshot(notification.sessionId, entry.terminalId)
                  ?.output ?? `[terminal ${entry.terminalId}]`,
            },
          },
  );
  return { ...notification, update: { ...update, content: mapped } };
}
