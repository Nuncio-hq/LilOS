/**
 * Issue #583 live leg (Group C: #583/#585/#589 wire legs) — on real
 * `hermes serve`:
 *
 *   bun scripts/live/583.ts [--engine hermes] [--seconds 120]
 *
 * Spawns the real relay + harness + `hermes serve` (the same env shape as
 * the #106 approval-modes leg), then:
 *
 *   1. (#589) `system.status {logLines:5}` — the call the first-run ticks
 *      poll — reports relay + engine components "ok" and returns the
 *      relay/harness log tails the status dialog's Copy diagnostics reads;
 *   2. (#583) a gated terminal call under manual approvals opens a REAL
 *      `approval` ask on the wire — the open request the composer reads
 *      to say "waiting for your approval";
 *   3. (#585) answering `deny` resolves the ask — and the RESOLVED ask
 *      stays on the wire (asks.list still lists it), which is what keeps
 *      the denied card visible on the turn; the conversation settles.
 *
 * Engine: LILOS_ENGINE (default hermes) + HERMES_PROVIDER/HERMES_MODEL,
 * set by scripts/live/583.sh (stub provider when no real model is signed
 * in). Prints PASS/FAIL. Exit 0 only on PASS.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative import: scripts/ is not a workspace dir, so @lilos/* does not
// resolve here — the package resolves its own deps internally.
import { RelayClient } from "../../packages/client-runtime/src/index";
import {
  cleanup,
  freePort,
  launch,
  startStub,
  waitForFile,
} from "./lib/helpers";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const seconds = Number(arg("seconds", "120") ?? "120");
const engineKind =
  arg("engine", process.env.LILOS_ENGINE ?? "hermes") ?? "hermes";

const out = (line: string) => console.log(`[live-583] ${line}`);
let harnessHome = "";
const fail = (line: string): never => {
  console.error(`[live-583] FAIL ${line}`);
  try {
    console.error(readFileSync(join(harnessHome, "harness.log"), "utf8"));
  } catch {
    /* no log file */
  }
  process.exit(1);
};

/* Stub mode: 583.sh exports LILOS_STUB_PORT — startStub binds it and
   resolves on the "listening" line (scripted via STUB_SCRIPT). */
const stub = process.env.LILOS_STUB_PORT
  ? await startStub(Number(process.env.LILOS_STUB_PORT))
  : null;
if (stub) out(`openai-stub listening on :${stub.port}`);

const relayPort = await freePort();
const feedPort = await freePort();
const relayHome = mkdtempSync(join(tmpdir(), "lilos583-relay-"));
harnessHome = mkdtempSync(join(tmpdir(), "lilos583-harness-"));

// A real git repo so the chmod lands on a tracked file.
const picked = mkdtempSync(join(tmpdir(), "lilos583-picked-"));
writeFileSync(join(picked, "README.md"), "# repo\n");
execSync(
  "git init -b main && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init",
  { cwd: picked },
);

const teardown = () => cleanup(relayHome, harnessHome, picked);
process.on("SIGINT", () => {
  teardown();
  process.exit(130);
});

launch("relay", ["bun", "apps/relay/src/index.ts"], {
  LILOS_RELAY_HOME: relayHome,
  LILOS_RELAY_PORT: String(relayPort),
});

const relayToken = await waitForFile(join(relayHome, "relay-token")).catch(
  (e) => fail(String(e)),
);
const relayUrl = `ws://127.0.0.1:${relayPort}/ws`;
out(`relay ws ${relayUrl}`);

{
  const deadline = Date.now() + 10_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${relayPort}/health`);
      if (res.ok || res.status === 404) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) fail("relay did not come up");
}

const workdir = join(harnessHome, "work");
launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: workdir,
  LILOS_ENGINE: engineKind,
  LILOS_FEED_PORT: String(feedPort),
  LILOS_REPO_ROOT: repoRoot,
});
out(`harness launched (engine=${engineKind}, workdir=${workdir})`);

{
  const deadline = Date.now() + 30_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${feedPort}/host`, {
        method: "OPTIONS",
      });
      if (res.status === 204) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) fail("harness feed did not come up");
}

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-583", version: "0" },
});
await user.connect().catch((e) => fail(`relay connect: ${e}`));

const deadline = Date.now() + seconds * 1000;
const waitFor = async <T>(
  what: string,
  fn: () => T | undefined | Promise<T | undefined>,
): Promise<T> => {
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fail(`timed out waiting for ${what}`);
};

/* ── Leg 0 (#589): system.status — the first-run ticks' data source ── */
const status = await waitFor("engine up via system.status", async () => {
  const s = await user.request<{
    components: { id: string; state: string }[];
    logs?: { relay?: string[]; harness?: string[] };
  }>("system.status", { logLines: 5 });
  return s.components.find((c) => c.id === "engine")?.state === "ok"
    ? s
    : undefined;
});
if (!status.components.find((c) => c.id === "relay"))
  fail("system.status has no relay component — first-run leg 1 reads it");
const relayTail = status.logs?.relay?.length ?? 0;
const harnessTail = status.logs?.harness?.length ?? 0;
if (!relayTail || !harnessTail)
  fail(
    `system.status {logLines:5} returned no log tails ` +
      `(relay=${relayTail}, harness=${harnessTail}) — ` +
      `Copy diagnostics reads these`,
  );
out(
  `PASS leg0: system.status ok (engine + relay), log tails ` +
    `relay=${relayTail} harness=${harnessTail}`,
);

/* ── ask under manual approvals, like the app's default Ask access ── */
const before = (
  await user.request<{
    engine?: {
      capabilities?: { id: string; detail?: { current?: string } }[];
    };
  }>("system.status", { logLines: 0 })
).engine?.capabilities?.find((c) => c.id === "approval_policy")?.detail
  ?.current;
await user.request("approvals.setPolicy", { policy: "manual" });

try {
  const { employee } = await user.request<{ employee: { id: string } }>(
    "employees.create",
    { name: "Ada", role: "engineer" },
  );
  const { channel } = await user.request<{
    channel: { id: string; employeeId: string };
  }>("channels.openDm", { employeeId: employee.id });

  const asksList = async (convId: string, state?: string) =>
    (
      await user.request<{
        asks: {
          id: string;
          request: { kind: string; options?: string[] };
          state: string;
          outcome?: string;
        }[];
      }>("asks.list", { conversationId: convId, ...(state ? { state } : {}) })
    ).asks;

  const convState = async (convId: string) =>
    (
      await user.request<{ conversations: { id: string; state: string }[] }>(
        "conversations.list",
        { channelId: channel.id },
      )
    ).conversations.find((c) => c.id === convId)?.state;

  const PROMPT =
    "LILOS583 — run this terminal command verbatim: `chmod 777 README.md` — then reply with exactly: LILOS_OK";

  /* ── Leg 1 (#583): the gated call opens a real approval ask ── */
  const { conversation } = await user.request<{
    conversation: { id: string };
  }>("conversations.open", {
    channelId: channel.id,
    text: PROMPT,
    title: "waiting states",
    cwd: picked,
  });

  const ask = await waitFor("open approval ask", async () =>
    (await asksList(conversation.id, "open")).find(
      (a) => a.request.kind === "approval",
    ),
  );
  out(
    `PASS leg1: open approval ask on the wire — the request that parks ` +
      `the composer ("waiting for your approval")`,
  );

  /* ── Leg 2 (#585): deny — the RESOLVED ask stays on the wire ── */
  await user.request("asks.respond", { askId: ask.id, outcome: "deny" });
  const denied = await waitFor("denied ask to resolve", async () =>
    (await asksList(conversation.id)).find(
      (a) => a.id === ask.id && a.state === "resolved",
    ),
  );
  if (denied.outcome !== "deny")
    fail(`resolved ask outcome=${denied.outcome}, expected deny`);
  out(
    "PASS leg2: denied ask stays listed as resolved — the card the " +
      "thread keeps showing",
  );

  await waitFor("turn to settle after the deny", async () => {
    const s = await convState(conversation.id);
    return s === "idle" || s === "closed" ? s : undefined;
  });
  out("PASS leg3: the turn settled after the deny");
} finally {
  if (before && before !== "manual") {
    await user
      .request("approvals.setPolicy", { policy: before })
      .catch(() => {});
    out(`policy restored to ${before}`);
  }
}

user.close();
teardown();
console.log("[live-583] PASS all legs");
process.exit(0);
