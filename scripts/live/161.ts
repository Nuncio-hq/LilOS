/**
 * Issue #161 live leg — Expo push notifications: relay → Expo push → APNs.
 *
 *   bun scripts/live/161.ts
 *
 * Boots a real relay + real harness (engine-fake by default) plus a local
 * Expo stub the relay's `LILOS_EXPO_ENDPOINT` is pointed at. The stub logs
 * every push payload the relay sends and — unless LILOS_EXPO_DRYRUN=1 —
 * forwards them to the real exp.host, so a paired physical iPhone buzzes
 * for real while the script still prints what was sent and what Expo said
 * (a dead token's DeviceNotRegistered drop is visible too, AC-7).
 *
 * Scripted proof without a phone: a stub device pairs for real
 * (pairing.offer → /pair/exchange → device hello), registers a push token
 * with `push.register`, then the engine-fake drives the transitions —
 * approval ask (needs-you), approve → turn completes, a refusal (failed) —
 * and the collector prints each push the relay sent. The suppression leg
 * reports the thread open via `push.visibility` and shows the relay going
 * quiet for that device.
 *
 * On this VM set TAILSCALE_IP=172.16.4.2 (loopback-side stand-in); on
 * Oscar's Mac leave it unset so the real tailscale probe advertises the
 * Mac's tailnet name — his phone pairs with the printed lilos:// link.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPO_PUSH_URL } from "../../apps/relay/src/expo";
import {
  exchangePairingGrant,
  RelayClient,
} from "../../packages/client-runtime/src/index";

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const engineKind = process.env.LILOS_ENGINE ?? "fake";
const relayPort = Number(process.env.LILOS_RELAY_PORT ?? "4577");
const stubPort = Number(process.env.LILOS_EXPO_STUB_PORT ?? "4610");
const tailscaleIp = process.env.TAILSCALE_IP;
const employeeName = process.env.EMPLOYEE_NAME ?? "Ada";
const fakeTick = process.env.ENGINE_FAKE_TICK ?? "150";
const dryRun = process.env.LILOS_EXPO_DRYRUN === "1";
const STUB_TOKEN = "ExponentPushToken[stub-phone-deadbeef]";

const out = (line: string) => console.log(`[live-161] ${line}`);
const relayHome = mkdtempSync(join(tmpdir(), "lilos161-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos161-harness-"));
const picked = mkdtempSync(join(tmpdir(), "lilos161-repo-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: picked });
execFileSync("git", ["-C", picked, "config", "user.email", "live@lilos"]);
execFileSync("git", ["-C", picked, "config", "user.name", "lilos live"]);
writeFileSync(join(picked, "README.md"), "# live-161 scratch repo\n");
execFileSync("git", ["-C", picked, "add", "README.md"]);
execFileSync("git", ["-C", picked, "commit", "-qm", "init"]);

/* ── The Expo stub: a collector + optional forwarder ───────────────────── */

interface PushLine {
  to: string;
  title: string;
  /** iOS subtitle — the thread title (#289). */
  subtitle?: string;
  body: string;
  data?: { conversationId?: string };
}
const pushes: PushLine[] = [];
const receipts: { to: string; status: string; error?: string }[] = [];
const waiters: ((p: PushLine) => void)[] = [];

const expoStub: Server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    let messages: PushLine[] = [];
    try {
      messages = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400).end('{"data":[]}');
      return;
    }
    for (const m of messages) {
      pushes.push(m);
      out(
        `PUSH -> ${m.to.slice(0, 40)} | "${m.title}" / "${m.subtitle ?? "-"}": ${m.body} ` +
          `(conv ${m.data?.conversationId ?? "-"})`,
      );
      for (const w of waiters.splice(0)) w(m);
    }
    if (dryRun) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: messages.map((_, i) => ({ status: "ok", id: `stub-${i}` })),
        }),
      );
      return;
    }
    // Real leg: forward to exp.host and hand the receipts back verbatim.
    try {
      const up = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(messages),
      });
      const body = await up.text();
      res.writeHead(up.status, { "content-type": "application/json" });
      res.end(body);
      const parsed = JSON.parse(body) as {
        data?: { status: string; details?: { error?: string } }[];
      };
      (parsed.data ?? []).forEach((ticket, i) => {
        const target = messages[i]?.to ?? "?";
        receipts.push({
          to: target,
          status: ticket.status,
          error: ticket.details?.error,
        });
        out(
          `  receipt ${target.slice(0, 40)}: ${ticket.status}` +
            (ticket.details?.error ? ` (${ticket.details.error})` : ""),
        );
      });
    } catch (error) {
      out(`  forward to exp.host failed: ${error}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: messages.map(() => ({
            status: "error",
            message: "stub forward failed",
          })),
        }),
      );
    }
  });
});
await new Promise<void>((r) => expoStub.listen(stubPort, "127.0.0.1", r));
out(
  `expo stub on http://127.0.0.1:${stubPort} ` +
    `(${dryRun ? "dry-run — nothing reaches exp.host" : `forwarding to ${EXPO_PUSH_URL}`})`,
);

const nextPush = (ms = 12_000): Promise<PushLine | undefined> =>
  new Promise((resolve) => {
    const start = pushes.length;
    const timer = setTimeout(() => resolve(undefined), ms);
    const check = () => {
      if (pushes.length > start) {
        clearTimeout(timer);
        resolve(pushes[pushes.length - 1]);
      }
    };
    waiters.push(check);
  });

const procs: ChildProcess[] = [];
const launch = (name: string, cmd: string[], env: Record<string, string>) => {
  const child = spawn(cmd[0] ?? "bun", cmd.slice(1), {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(child);
  child.stdout?.on("data", (d) =>
    String(d)
      .trimEnd()
      .split("\n")
      .forEach((l) => void console.log(`  [${name}] ${l}`)),
  );
  child.stderr?.on("data", (d) =>
    String(d)
      .trimEnd()
      .split("\n")
      .forEach((l) => void console.error(`  [${name}!] ${l}`)),
  );
  return child;
};
const cleanup = () => {
  for (const p of procs) p.kill("SIGTERM");
  expoStub.close();
  rmSync(relayHome, { recursive: true, force: true });
  rmSync(harnessHome, { recursive: true, force: true });
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

launch("relay", ["bun", "apps/relay/src/index.ts"], {
  LILOS_RELAY_HOME: relayHome,
  LILOS_RELAY_PORT: String(relayPort),
  LILOS_EXPO_ENDPOINT: `http://127.0.0.1:${stubPort}/push/send`,
  ...(tailscaleIp ? { LILOS_RELAY_TAILSCALE_IP: tailscaleIp } : {}),
});

const waitForFile = async (path: string, ms = 10_000): Promise<string> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
};

const relayToken = await waitForFile(join(relayHome, "relay-token"));
const relayUrl = `ws://127.0.0.1:${relayPort}/ws`;
const relayHttp = `http://127.0.0.1:${relayPort}`;
out(`relay ws ${relayUrl} (home ${relayHome})`);

{
  const deadline = Date.now() + 10_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${relayHttp}/health`);
      if (res.ok || res.status === 404) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) throw new Error("relay did not come up");
}

const workdir = join(harnessHome, "work");
launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: workdir,
  LILOS_ENGINE: engineKind,
  ENGINE_FAKE_TICK: fakeTick,
});
out(
  `harness launched (engine=${engineKind}, workdir=${workdir}, tick=${fakeTick}ms)`,
);

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-161", version: "0" },
});
await user.connect().catch((e) => {
  throw new Error(`relay connect: ${e}`);
});

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: employeeName, role: "engineer" },
);
out(`employee ${employeeName} (${employee.id})`);

await user.request("folders.add", { path: picked });
out(`seeded recents: ${picked}`);

const { channel } = await user.request<{ channel: { id: string } }>(
  "channels.openDm",
  { employeeId: employee.id },
);

/* A real paired device with a fake push token — exercises push.register /
   push.visibility / the relay's token drop, no iPhone needed. */
const { offer: stubOffer } = await user.request<{
  offer: { host: string; code: string };
}>("pairing.offer", {});
const stubPair = await exchangePairingGrant(relayHttp, {
  code: stubOffer.code,
  name: "stub-phone",
});
if (!("device" in stubPair)) throw new Error("stub pairing failed");
const stubPhone = new RelayClient({
  url: relayUrl,
  device: { deviceId: stubPair.device.id, credential: stubPair.credential },
  client: { name: "lilos-stub-phone", version: "0" },
});
await stubPhone.connect();
const ALL_ON = {
  needsApproval: true,
  waitingForInput: true,
  completed: true,
  failed: true,
};
await stubPhone.request("push.register", {
  token: STUB_TOKEN,
  prefs: ALL_ON,
});
out(`stub phone paired + registered (${stubPair.device.id})`);

const note = (s: string) => console.log(`\n  ── ${s} ──`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* Approve every open ask in the thread, waiting for stragglers — an
   engine-fake turn can raise several; a queued prompt only runs once the
   current turn finishes, so each step drains before the next starts. */
const approveAll = async (convId: string): Promise<void> => {
  for (let round = 0; round < 20; round++) {
    await sleep(400);
    const { asks } = await user.request<{ asks: { id: string }[] }>(
      "asks.list",
      { conversationId: convId, state: "open" },
    );
    if (!asks.length) {
      if (round >= 4) return; // two quiet polls = the turn's done asking
      continue;
    }
    for (const a of asks) {
      await user.request("asks.respond", { askId: a.id, outcome: "once" });
    }
  }
};

/* Real forward mode: each send gets a DeviceNotRegistered receipt for the
   stub token and the relay drops the row (AC-7, live). Legs therefore
   re-register before the next push — after a beat so the previous send's
   receipt has landed and can't drop the fresh registration. */
const reregisterStub = async () => {
  await sleep(750);
  await stubPhone.request("push.register", {
    token: STUB_TOKEN,
    prefs: ALL_ON,
  });
};

/* Each step drives its own conversation so a queued prompt in one thread
   can't bleed into the next step's assertion window. */
const openConversation = async (text: string, title: string) => {
  const { conversation } = await user.request<{
    conversation: { id: string };
  }>("conversations.open", {
    channelId: channel.id,
    text,
    title,
  });
  return conversation.id;
};

/* Poll the collected pushes for a match within the window. */
const awaitPush = async (
  match: (p: PushLine) => boolean,
  start: number,
  ms = 15_000,
): Promise<PushLine | undefined> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = pushes.slice(start).find(match);
    if (found) return found;
    await sleep(200);
  }
  return undefined;
};

/* Step 1 — an approval ask pushes needs-you (body = what it needs); the
   approve then finishes the turn → a 'done' push (subtitle = thread title,
   body = the reply excerpt, #289). */
note("needs-you: a mutating prompt → approval ask → push");
const convA = await openConversation("fix the readme", "Fix the readme");
{
  const askPush = await nextPush();
  out(
    askPush
      ? `  PASS needs-you push → ${askPush.to.slice(0, 44)}: ${askPush.body}`
      : "  FAIL no push collected for the approval ask",
  );

  note("completed: approving the asks ends the turn → push");
  await reregisterStub();
  const start = pushes.length;
  const waiter = awaitPush(
    (p) => p.to === STUB_TOKEN && p.subtitle === "Fix the readme",
    start,
    30_000,
  );
  await approveAll(convA);
  const completion = await waiter;
  out(
    completion
      ? `  PASS done push: "${completion.title}" / "${completion.subtitle}": ${completion.body}`
      : "  FAIL no push on turn completion",
  );
}

/* Step 2 — AC-5: the stub phone reports the thread open → the ask AND its
   completion stay quiet for it (any real paired phone still pushes). */
note("suppression: stub phone reports the thread open → silent for it");
await reregisterStub();
const convB = await openConversation(
  "this only primes the thread",
  "Suppression demo",
);
await approveAll(convB);
await stubPhone.request("push.visibility", { conversationId: convB });
const suppressedStart = pushes.length;
await user.request("messages.post", {
  channelId: channel.id,
  conversationId: convB,
  text: "fix the license file too",
});
// Let the ask open, then approve it so its completion is covered by the
// same silence check.
await sleep(2_000);
await approveAll(convB);
await sleep(1_500);
const forStub = pushes
  .slice(suppressedStart)
  .filter((p) => p.to === STUB_TOKEN);
out(
  forStub.length === 0
    ? "  PASS no push to the phone that has the thread open"
    : `  FAIL ${forStub.length} push(es) went to the viewing phone`,
);

/* Step 3 — un-suppress + a refused turn pushes 'failed' (engine-fake: a
   prompt starting "fail" ends as a refusal — no ask to drain). */
note("un-suppress + failed: report null → 'fail …' refusal → push");
await reregisterStub();
await stubPhone.request("push.visibility", { conversationId: null });
const failStart = pushes.length;
await openConversation("fail this task", "Failure demo");
// convB's turn completion can land right as suppression lifts — match the
// refusal's own thread title (now the subtitle), not just the first push.
const failPush = await awaitPush(
  (p) => p.to === STUB_TOKEN && p.subtitle === "Failure demo",
  failStart,
  20_000,
);
out(
  failPush
    ? `  PASS failure push: "${failPush.title}" / "${failPush.subtitle}": ${failPush.body}`
    : "  FAIL no push on refusal",
);

/* Oscar's leg: a real pairing offer for the physical iPhone. */
const { offer } = await user.request<{
  offer: { host: string; code: string; name: string; expiresAt: number };
}>("pairing.offer", {});
const link = `lilos://pair?host=${encodeURIComponent(offer.host)}&name=${encodeURIComponent(offer.name)}#code=${offer.code}`;
console.log("");
console.log("  ── Your iPhone ──");
console.log("  Deep link (valid ~5 min):");
console.log(`    ${link}`);
console.log("");
console.log("  Simulator:");
console.log(`    xcrun simctl openurl booted '${link.replace(/'/g, "'\\''")}'`);
console.log("");
console.log("  On the phone: pair, allow notifications, then check");
console.log("  Settings → Notifications — four toggles. Background the app,");
console.log(
  `  open ${employeeName}'s DM on the Mac and send "fix the readme":`,
);
console.log("  a push lands titled by the employee; tapping it opens the");
console.log("  thread — even from a killed app. With the thread open on the");
console.log("  phone, the same prompt sends nothing (AC-5). Flip a toggle off");
console.log("  and that kind stops.");
if (!dryRun)
  console.log(
    "  The stub phone's fake token gets a real DeviceNotRegistered — watch",
  );
console.log("");
out("running until Ctrl-C");
await new Promise(() => {});
