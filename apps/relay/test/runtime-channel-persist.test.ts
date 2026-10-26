import { spawnSync } from "node:child_process";
import { RelayClient } from "@lilos/client-runtime";
import { describe, expect, it } from "vitest";
import { BUN, RELAY_DIR, startRelay, wsFactory } from "./helpers";

/**
 * D-#761 re-review: on the owner's install `messages.list` on a coding-agent
 * DM returned `not_found` even though the channel row existed. The scenario
 * that mattered: the relay had booted on an *existing* database and applied
 * the v35→v36 migration (`employees.runtime`) in place — the hire + DM +
 * open + list sequence then ran on that migrated store.
 *
 * These specs pin the wire-level contract on exactly that shape: a relay
 * restarted onto an existing file (once pre-migration, once post-) must
 * answer `messages.list` for a runtime employee's DM channel. If the
 * not_found ever returns, the enriched error data names the channel id the
 * store was asked for.
 */

const connect = (url: string, token: string) =>
  new RelayClient({
    url,
    token,
    socketFactory: wsFactory().factory,
    autoReconnect: false,
    client: { name: "e2e-runtime-dm" },
  });

type Employee = { id: string; runtime?: string };
type Channel = { id: string; kind: string };
type Page = { messages: { id: string; text: string }[]; lastSeq: number };

const reviewerSequence = async (client: RelayClient) => {
  const { employee } = await client.request<{ employee: Employee }>(
    "employees.create",
    { name: "Devin", runtime: "acp:devin", profile: "devin" },
  );
  expect(employee.runtime).toBe("acp:devin");
  const { channel } = await client.request<{ channel: Channel }>(
    "channels.openDm",
    { employeeId: employee.id },
  );
  const { conversation } = await client.request<{
    conversation: { id: string };
  }>("conversations.open", {
    channelId: channel.id,
    text: "hello devin",
    cwd: "/tmp",
  });
  expect(conversation.id).toMatch(/^conv_/);
  const page = await client.request<Page>("messages.list", {
    channelId: channel.id,
    limit: 50,
  });
  expect(page.messages).toHaveLength(1);
  expect(page.messages[0]?.text).toBe("hello devin");
  expect(page.lastSeq).toBe(1);
  return channel;
};

describe("D-#761: runtime employee DM channel is readable after a restart", () => {
  it("boots on an existing DB, then hire -> openDm -> open -> messages.list", async () => {
    const first = await startRelay();
    const seeded = connect(first.url, first.token);
    await seeded.connect();
    // Prior install data — a default employee's DM with a message.
    const { employee: boss } = await seeded.request<{ employee: Employee }>(
      "employees.create",
      { name: "default", role: "default" },
    );
    const { channel: bossCh } = await seeded.request<{ channel: Channel }>(
      "channels.openDm",
      { employeeId: boss.id },
    );
    await seeded.request("conversations.open", {
      channelId: bossCh.id,
      text: "prior install",
    });
    seeded.close();
    first.proc.kill("SIGKILL");
    await new Promise<void>((r) => first.proc.once("exit", () => r()));

    // Second boot on the existing file — the upgrade-in-place shape.
    const second = await startRelay(first.home);
    const client = connect(second.url, second.token);
    await client.connect();
    const channel = await reviewerSequence(client);

    // The pre-existing channel still answers too.
    const bossPage = await client.request<Page>("messages.list", {
      channelId: bossCh.id,
      limit: 50,
    });
    expect(bossPage.messages).toHaveLength(1);
    client.close();
    second.proc.kill("SIGKILL");
    await new Promise<void>((r) => second.proc.once("exit", () => r()));

    // Third boot: the runtime channel persists across another restart.
    const third = await startRelay(first.home);
    const again = connect(third.url, second.token);
    await again.connect();
    const page = await again.request<Page>("messages.list", {
      channelId: channel.id,
      limit: 50,
    });
    expect(page.messages).toHaveLength(1);
    again.close();
  }, 60_000);

  it("boots on a DB still at v35, migrates, then serves the runtime DM", async () => {
    const first = await startRelay();
    const seeded = connect(first.url, first.token);
    await seeded.connect();
    const { employee: boss } = await seeded.request<{ employee: Employee }>(
      "employees.create",
      { name: "default", role: "default" },
    );
    const { channel: bossCh } = await seeded.request<{ channel: Channel }>(
      "channels.openDm",
      { employeeId: boss.id },
    );
    await seeded.request("conversations.open", {
      channelId: bossCh.id,
      text: "prior install",
    });
    seeded.close();
    first.proc.kill("SIGKILL");
    await new Promise<void>((r) => first.proc.once("exit", () => r()));

    /* Roll the file back to v35 the way a real pre-#761 install looks:
       drop every column v36+ added, rewind user_version. The next boot's
       migration re-adds them — the exact path the owner's relay took.
       bun:sqlite runs under bun only (migrate.test.ts convention). */
    const res = spawnSync(
      BUN,
      [
        "-e",
        `import { Database } from "bun:sqlite";
         const db = new Database(${JSON.stringify(`${first.home}/relay.sqlite`)});
         db.exec("ALTER TABLE employees DROP COLUMN runtime");
         for (const col of ["pinned_at","settled_at","settled_reason","settled_pr","snoozed_until","auto_settle"])
           db.exec("ALTER TABLE conversations DROP COLUMN " + col);
         db.exec("PRAGMA user_version = 35");
         db.close();`,
      ],
      { cwd: RELAY_DIR, encoding: "utf8" },
    );
    expect(res.status, res.stderr).toBe(0);

    const second = await startRelay(first.home);
    const client = connect(second.url, second.token);
    await client.connect();
    await reviewerSequence(client);
    client.close();
  }, 60_000);
});
