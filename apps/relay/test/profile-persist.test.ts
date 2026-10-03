import { RelayClient } from "@lilos/client-runtime";
import { describe, expect, it } from "vitest";
import { startRelay, wsFactory } from "./helpers";

/**
 * Issue #118 AC-1 + AC-4: the profile lives in sqlite, so a migration-8
 * DB reports an empty profile on a fresh/existing install (the app prefills
 * from the OS) and values written once survive a relay restart. The
 * spawn/ws helpers mirror folders-persist.test.ts.
 */

const connect = (url: string, token: string) =>
  new RelayClient({
    url,
    token,
    socketFactory: wsFactory().factory,
    autoReconnect: false,
    client: { name: "e2e-profile" },
  });

describe("AC-1/AC-4 profile settings persist in sqlite", () => {
  it("fresh DB reports empty profile; an update survives a relay restart", async () => {
    const first = await startRelay();
    const client = connect(first.url, first.token);
    await client.connect();

    // Migrated-but-untouched install: nothing stored, the app prefills.
    const before = await client.request<{ profile: Record<string, string> }>(
      "profile.get",
      {},
    );
    expect(before.profile).toEqual({});

    await client.request("profile.update", {
      userName: "Ada",
      companyName: "Ada Labs",
      avatarColor: "bg-rose-600",
    });
    client.close();
    first.proc.kill("SIGKILL");
    await new Promise<void>((r) => first.proc.once("exit", () => r()));

    const second = await startRelay(first.home);
    const back = connect(second.url, first.token);
    await back.connect();

    const { profile } = await back.request<{
      profile: Record<string, string>;
    }>("profile.get", {});
    expect(profile).toEqual({
      userName: "Ada",
      companyName: "Ada Labs",
      avatarColor: "bg-rose-600",
    });
    back.close();
  }, 30_000);
});
