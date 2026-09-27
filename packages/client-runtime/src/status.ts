import type { StatusComponent, SystemStatusResult } from "@lilos/contracts/app";
import type { RelayConnectionState, RelayError } from "./client";

/** Latest `system.status` poll plus the transport state it was taken under. */
export interface StatusPollState {
  connection: RelayConnectionState;
  result?: SystemStatusResult;
  /** ms epoch of the last successful poll. */
  fetchedAt?: number;
  error?: string;
}

/**
 * A status row as the app shows it (#53): the wire component plus the
 * plain-language presentation derived once, here. `reason` is the one-line
 * plain cause, `hint` the next step, `detail` the raw wire text whenever the
 * display rewrote it — rendered collapsed and kept in Copy diagnostics.
 */
export interface StatusRow extends StatusComponent {
  /** One plain next step ("Check the engine path in Settings."). */
  hint?: string;
  /** Raw wire reason — the collapsed details line keeps it. */
  detail?: string;
}

const sentence = (s: string): string => {
  const t = s.trim();
  if (!t) return t;
  const cased = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cased) ? cased : `${cased}.`;
};

/** Looks like a raw exception chain rather than a sentence Oscar can read. */
const LOOKS_TECHNICAL =
  /Error:|ENOENT|EACCES|EADDRINUSE|ECONN[A-Z]*|posix_spawn|spawn\b|exit code|signal \w+|exception|TypeError|ReferenceError|at [\w.<>]+ \(|0x[0-9a-f]+/i;

interface PlainReason {
  reason: string;
  hint?: string;
}

/**
 * The ONE place raw wire reasons become plain language (issue #53): every row
 * — from `system.status` or synthesized when the relay is unreachable — goes
 * through `toPlainRow`, first matching rule wins. `detail` keeps the raw text
 * so the dialog's collapsed line and Copy diagnostics lose nothing.
 */
const PLAIN_RULES: {
  match: RegExp;
  plain: (c: StatusComponent, m: RegExpExecArray) => PlainReason;
}[] = [
  {
    // The synthesized relay reason already names the stale side — keep it.
    match: /protocol mismatch — update the (\w+)/i,
    plain: (_c, m) => ({
      reason: `Version mismatch — update the ${m[1]}.`,
      hint: "Update, then reopen LilOS.",
    }),
  },
  {
    // #85: Hermes discovery failures are already plain sentences — surface
    // them verbatim ("Hermes not found at …"), minus the supervisor's
    // "engine hermes failed to start x5:" prefix (kept in `detail`).
    match: /Hermes not found[^\n]*/,
    plain: (_c, m) => ({
      reason: sentence(m[0]),
      hint: "Install Hermes, or point LilOS at it with HERMES_BIN or ~/.lilos/hermes-bin — then restart the app.",
    }),
  },
  {
    // #95 AC-1: the too-old verdict is already the exact plain sentence —
    // surface it verbatim. The remedy (`hermes update`) is in the sentence,
    // so no separate hint.
    match: /Hermes [^\n]*?is too old[^\n]*/,
    plain: (_c, m) => ({ reason: sentence(m[0]) }),
  },
  {
    // #95 AC-2: the child died from a signal — the system stopped it, which
    // on a managed Mac usually means a device security policy. Explain, never
    // work around it.
    match: /killed by (SIG\w+)/,
    plain: (c, m) => ({
      reason: `The ${c.label.toLowerCase()} was stopped by the system (${m[1]}) — a device security policy may be blocking it.`,
    }),
  },
  {
    match: /ENOENT|posix_spawn|no such file|not found|spawn failed/i,
    plain: (c) => ({
      reason: `${c.label} couldn't start — the ${
        c.id === "engine" ? "engine " : ""
      }program wasn't found.`,
      hint: `Check the ${c.id === "engine" ? "engine" : "program"} path in Settings, then retry.`,
    }),
  },
  {
    match: /EACCES|permission denied|operation not permitted/i,
    plain: (c) => ({
      reason: `${c.label} couldn't start — macOS refused permission.`,
      hint: "Check the program's file permissions, then retry.",
    }),
  },
  {
    match: /EADDRINUSE|address already in use/i,
    plain: (c) => ({
      reason: `${c.label} couldn't start — something else is using its port.`,
      hint: "Quit the other app using the port, then retry.",
    }),
  },
  {
    match: /spoke protocol|protocol_version|protocol mismatch/i,
    plain: (c) => ({
      reason: `${c.label} speaks a different protocol version.`,
      hint: "Update LilOS and the harness to matching versions.",
    }),
  },
  {
    match: /unauthenticated|authentication failed|bad .*token|unauthorized/i,
    plain: (c) => ({
      reason: `${c.label} rejected the sign-in.`,
      hint: "Check the relay token — it lives in ~/.lilos/relay-token.",
    }),
  },
  {
    match: /timed?\s*out|timeout|not responding|did not report ready/i,
    plain: (c) => ({
      reason: `${c.label} isn't answering.`,
      hint: "Give it a moment; if it stays down, restart it.",
    }),
  },
  {
    match: /ECONNREFUSED|connection refused|unreachable|can't reach/i,
    plain: (c) => ({
      reason: `${c.label} isn't reachable.`,
      hint: "Check that it's running on this Mac, then retry.",
    }),
  },
  {
    match: /disconnect|connection (lost|closed)|socket closed|dropped/i,
    plain: (c) => ({
      reason: `${c.label} lost its connection.`,
      hint: "It usually restarts on its own; if not, start it again.",
    }),
  },
  {
    match: /heartbeat stale|stale|last successful probe/i,
    plain: (c) => ({
      reason: `${c.label} hasn't checked in recently.`,
      hint: "It may still be running — restart it if this stays.",
    }),
  },
  {
    match: /exit(ed)?\b|signal \w+|crash|failed|killed/i,
    plain: (c) => ({
      reason: `${c.label} stopped unexpectedly.`,
      hint: "Restart it — if it keeps failing, copy diagnostics and ask for help.",
    }),
  },
];

/** The next step for a downed leg when the wire reason is already plain. */
const LEG_HINT: Record<StatusComponent["id"], string> = {
  relay: "Start the relay on this Mac, then reopen LilOS.",
  harness: "Start the harness — the engine and model wait on it.",
  engine: "Restart the engine; if it keeps failing, copy diagnostics for help.",
  model: "Pick a model in Settings if this stays.",
};

/**
 * Wire row → display row. `ok`/`connecting` reasons are already plain and pass
 * through; `blocked` only gets sentence-cased; `down`/`degraded` reasons are
 * matched against PLAIN_RULES, with the raw text preserved in `detail`.
 */
function toPlainRow(c: StatusComponent): StatusRow {
  if (c.state === "ok") return c;
  if (c.state === "connecting") return { ...c, reason: sentence(c.reason) };
  if (c.state === "blocked") {
    // Normalize "waiting for a harness to register"-style reasons.
    const w = /^waiting for (?:a |the )?(\w+)/i.exec(c.reason);
    return {
      ...c,
      reason: w ? `Waiting for the ${w[1]}.` : sentence(c.reason),
    };
  }
  for (const rule of PLAIN_RULES) {
    const m = rule.match.exec(c.reason);
    if (!m) continue;
    const p = rule.plain(c, m);
    return {
      ...c,
      reason: p.reason,
      hint: p.hint,
      detail: p.reason === c.reason ? undefined : c.reason,
    };
  }
  if (LOOKS_TECHNICAL.test(c.reason)) {
    return {
      ...c,
      reason:
        c.state === "down"
          ? `${c.label} is down.`
          : `${c.label} is having trouble.`,
      hint: "Copy diagnostics and send it to whoever maintains this Mac.",
      detail: c.reason,
    };
  }
  return { ...c, reason: sentence(c.reason), hint: LEG_HINT[c.id] };
}

/**
 * The rows as they come off the wire — `system.status` components, or the
 * synthesized set when the relay itself is unreachable. Reasons here stay raw
 * (technical); `toStatusComponents` maps them for display and
 * `formatDiagnostics` prints them as-is so the bundle keeps the real error.
 */
function wireComponents(input: {
  result?: SystemStatusResult;
  connection: RelayConnectionState;
  fatal?: RelayError;
}): StatusComponent[] {
  const { result, connection, fatal } = input;
  if (result) return result.components;

  const relay: StatusComponent = {
    id: "relay",
    label: "Relay",
    state: "down",
    reason: "",
  };
  if (fatal?.code === "protocol_version_mismatch") {
    const data = fatal.data as { update?: string } | undefined;
    relay.reason = `protocol mismatch — update the ${
      data?.update === "server" ? "relay" : "app"
    }`;
  } else if (fatal?.code === "unauthenticated") {
    relay.reason = "authentication failed — bad relay token";
  } else if (connection === "connecting" || connection === "reconnecting") {
    relay.state = "connecting";
    relay.reason =
      connection === "connecting"
        ? "connecting to relay"
        : "reconnecting to relay";
  } else {
    relay.reason =
      connection === "idle" ? "not connected yet" : "relay unreachable";
  }
  // Legs downstream of an unreachable relay didn't fail — they're blocked
  // waiting on it (#53).
  const waiting =
    relay.state === "connecting"
      ? "waiting for the relay"
      : "waiting for the relay — it's unreachable";
  return [
    relay,
    { id: "harness", label: "Harness", state: "blocked", reason: waiting },
    { id: "engine", label: "Engine", state: "blocked", reason: waiting },
    { id: "model", label: "Model", state: "blocked", reason: waiting },
  ];
}

/**
 * Wire result → the four rows the status UI renders (`packages/ui` shares the
 * shape plus `hint`/`detail`). With no result — socket down, handshake fatal —
 * the rows are synthesized so Oscar always sees all four legs with a reason.
 */
export function toStatusComponents(input: {
  result?: SystemStatusResult;
  connection: RelayConnectionState;
  fatal?: RelayError;
}): StatusRow[] {
  return wireComponents(input).map(toPlainRow);
}

const humanBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
};

/**
 * The text the "Copy diagnostics" button lands on the clipboard (issue #33).
 * Reasons stay in wire form (raw technical detail, #53); log tails arrive
 * already redacted by the relay.
 */
export function formatDiagnostics(input: {
  result?: SystemStatusResult;
  connection: RelayConnectionState;
  fatal?: RelayError;
  error?: string;
  app?: { name?: string; version?: string };
}): string {
  const { result, connection, fatal, error, app } = input;
  const lines: string[] = [
    `LilOS diagnostics — ${new Date(result?.generatedAt ?? Date.now()).toISOString()}`,
    `connection: ${connection}`,
  ];
  if (app?.name) lines.push(`app: ${app.name} ${app.version ?? ""}`.trim());
  if (result) lines.push(`protocol: ${result.protocolVersion}`);
  if (error) lines.push(`error: ${error}`);
  if (fatal) lines.push(`fatal: ${fatal.message}`);

  // Wire-form rows — the bundle keeps the raw reasons for whoever reads them.
  lines.push("", "Components");
  for (const c of wireComponents({ result, connection, fatal })) {
    lines.push(`- ${c.id.padEnd(8)} ${c.state.padEnd(10)} ${c.reason}`);
  }

  if (result) {
    lines.push("", "Versions");
    lines.push(
      `relay: ${result.versions.relay} (protocol ${result.versions.relayProtocol})`,
    );
    if (result.versions.harness !== undefined) {
      lines.push(
        `harness: ${result.versions.harness} (protocol ${result.versions.harnessProtocol ?? "?"})`,
      );
    } else {
      lines.push("harness: not registered");
    }
    if (result.engine) {
      lines.push("", "Engine");
      if (result.engine.name) {
        lines.push(
          `name: ${result.engine.name}${result.engine.version ? ` ${result.engine.version}` : ""}`,
        );
      }
      if (result.engine.rssBytes !== undefined) {
        lines.push(
          `rss: ${humanBytes(result.engine.rssBytes)} (${result.engine.rssBytes} bytes)`,
        );
      }
      if (result.engine.sessions !== undefined) {
        lines.push(`sessions: ${result.engine.sessions}`);
      }
    }
    if (result.mismatch) {
      lines.push("", "Mismatch");
      lines.push(
        `update the ${result.mismatch.update} — ${result.mismatch.detail}`,
      );
    }
    if (result.logs) {
      if (result.logs.relay.length > 0) {
        lines.push("", "Relay log (recent)");
        lines.push(...result.logs.relay);
      }
      if (result.logs.harness.length > 0) {
        lines.push("", "Harness log (recent)");
        lines.push(...result.logs.harness);
      }
    }
  }
  return lines.join("\n");
}
