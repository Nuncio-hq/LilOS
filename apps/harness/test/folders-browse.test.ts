import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelaySocket, SocketFactory } from "@lilos/client-runtime";
import { RelayClient, RelayError } from "@lilos/client-runtime";
import type {
  Conversation,
  FoldersBrowseResult,
  FoldersDiscoverResult,
} from "@lilos/contracts/app";
import { APP_PROTOCOL_VERSION } from "@lilos/contracts/app";
import { connectFake, FakeEngine } from "@lilos/engine-fake";
import { afterEach, describe, expect, it } from "vitest";
import { createPairingService } from "../../relay/src/pairing";
import { createRelay } from "../../relay/src/session";
import { createMemoryStore } from "../../relay/src/store";
import type { EngineConnection } from "../src/engine/client";
import { Harness } from "../src/harness";
import { createMemoryLogger } from "../src/log";
import { createFakeSleepGuard } from "../src/sleep";

/* `folders.browse`/`folders.discover` (#238): the phone's folder browser,
   driven by a device-scope client over a real relay + harness + tmpdir
   "home" on disk. The home-folder boundary is enforced by the harness
   (server-side) — every escape shape is refused before any listing. The
   pick then lands via `folders.add` and a session in it proves the cwd. */

const TOKEN = "test-token";

type Relay = ReturnType<typeof createRelay>;

const socketFor =
  (relay: Relay): SocketFactory =>
  () => {
    const listeners = new Map<string, Array<(e?: unknown) => void>>();
    const emit = (type: string, e?: unknown) =>
      queueMicrotask(() =>
        (listeners.get(type) ?? []).forEach((fn) => void fn(e)),
      );
    let peer: { receive(f: string): Promise<void>; closed(): void };
    let readyState = 0;
    const socket = {
      get readyState() {
        return readyState;
      },
      send: (frame: string) => {
        void peer.receive(frame);
      },
      close: () => {
        readyState = 3;
        peer.closed();
        emit("close", { code: 1000, reason: "closed" });
      },
      addEventListener(type: string, fn: (e?: unknown) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
    } as unknown as RelaySocket;
    peer = relay.connect({
      send: (frame) => emit("message", { data: frame }),
      close: (code, reason) => emit("close", { code, reason }),
    });
    queueMicrotask(() => {
      readyState = 1;
      emit("open");
    });
    return socket;
  };

const waitFor = async <T>(
  fn: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
};

const homes: string[] = [];
const mkhome = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lilos-home-")));
  homes.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

/** A real repo with one commit on `branch` at `dir` (inside `home`). */
function seedRepo(dir: string, branch = "main") {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", branch, dir]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "# seed\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-qm", "seed"]);
  return dir;
}

async function setupWorld(home: string) {
  const store = createMemoryStore();
  const pairing = createPairingService({ store });
  const relay = createRelay({ store, token: TOKEN, pairing, homeDir: home });
  const engine = new FakeEngine({ tick: 1 });
  const engineConn = connectFake(engine) as unknown as EngineConnection;
  const engineCalls: { method: string; params: unknown }[] = [];
  const origRequest = engineConn.request.bind(engineConn);
  engineConn.request = <T = unknown>(
    method: string,
    params?: unknown,
  ): Promise<T> => {
    engineCalls.push({ method, params });
    return origRequest<T>(method, params);
  };
  const harnessRelay = new RelayClient({
    url: "mem://harness",
    token: TOKEN,
    socketFactory: socketFor(relay),
    reconnectMinDelayMs: 20,
  });
  const harness = new Harness({
    relay: harnessRelay,
    sleep: createFakeSleepGuard(),
    workdir: join(home, "work"),
    log: createMemoryLogger(),
    homeDir: home,
  });
  harness.attachEngine(engineConn);
  await harness.start();

  /* The phone: a paired device peer, like the real app (#153). */
  const grant = await pairing.mintGrant();
  const ex = await pairing.exchangeGrant({ code: grant.code });
  if (!("device" in ex)) throw new Error("exchange failed");
  const phone = new RelayClient({
    url: "mem://phone",
    device: { deviceId: ex.device.id, credential: ex.credential },
    socketFactory: socketFor(relay),
  });
  await phone.connect();

  return {
    store,
    engineCalls,
    harness,
    phone,
    cleanup: async () => {
      phone.close();
      await harness.stop();
    },
  };
}

/** A fake "home": repos/, Desktop/, Documents/ (+hidden +file), a symlink out. */
function seedHome() {
  const home = mkhome();
  seedRepo(join(home, "repos", "crew"));
  seedRepo(join(home, "repos", "notes"), "feat/y");
  seedRepo(join(home, "Desktop", "demo"));
  mkdirSync(join(home, "Documents", "plain", "sub"), { recursive: true });
  mkdirSync(join(home, "Documents", ".hidden"), { recursive: true });
  writeFileSync(join(home, "Documents", "file.txt"), "hi");
  mkdirSync(join(home, "work"), { recursive: true });
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "lilos-out-")));
  homes.push(outside);
  symlinkSync(outside, join(home, "outlink"));
  return { home, outside };
}

const errorOf = async (p: Promise<unknown>): Promise<RelayError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RelayError);
    return e as RelayError;
  }
  throw new Error("expected the call to fail");
};

describe("AC-1 folders.browse — real dirs, hidden skipped, branch marks (#238)", () => {
  it("lists one level: dirs only, no dot-dirs, repos carry their branch", async () => {
    const { home } = seedHome();
    const w = await setupWorld(home);
    try {
      const res = await w.phone.request<FoldersBrowseResult>("folders.browse", {
        path: "~",
      });
      expect(res.path).toBe("~");
      const names = res.folders.map((f) => f.name);
      expect(names).toContain("Documents");
      expect(names).toContain("repos");
      expect(names).not.toContain(".hidden"); // (hidden lives under Documents)
      // files are never listed
      for (const f of res.folders) expect(f.path.startsWith("~/")).toBe(true);

      const repos = await w.phone.request<FoldersBrowseResult>(
        "folders.browse",
        { path: "~/repos" },
      );
      expect(repos.folders.map((f) => f.name).sort()).toEqual([
        "crew",
        "notes",
      ]);
      expect(repos.folders.find((f) => f.name === "crew")?.branch).toBe("main");
      expect(repos.folders.find((f) => f.name === "notes")?.branch).toBe(
        "feat/y",
      );

      // the listed dir itself reports its containing repo's branch
      const inside = await w.phone.request<FoldersBrowseResult>(
        "folders.browse",
        { path: "~/repos/crew" },
      );
      expect(inside.branch).toBe("main");
      // a plain dir reports no branch
      const plain = await w.phone.request<FoldersBrowseResult>(
        "folders.browse",
        { path: "~/Documents/plain" },
      );
      expect(plain.branch).toBeUndefined();
      expect(plain.folders.map((f) => f.name)).toEqual(["sub"]);
      // hidden dirs are never listed in the output
      const docs = await w.phone.request<FoldersBrowseResult>(
        "folders.browse",
        { path: "~/Documents" },
      );
      expect(docs.folders.map((f) => f.name)).toEqual(["plain"]);
    } finally {
      await w.cleanup();
    }
  });
});

describe("AC-2 folders.discover — same roots as web's Found on this Mac", () => {
  it("returns repos under ~/Desktop ~/Documents ~/repos with branches", async () => {
    const { home } = seedHome();
    const w = await setupWorld(home);
    try {
      const res = await w.phone.request<FoldersDiscoverResult>(
        "folders.discover",
        {},
      );
      const paths = res.repos.map((r) => r.path);
      expect(paths).toContain("~/repos/crew");
      expect(paths).toContain("~/repos/notes");
      expect(paths).toContain("~/Desktop/demo");
      // non-repo dirs are not repos
      expect(paths).not.toContain("~/Documents/plain");
      const crew = res.repos.find((r) => r.path === "~/repos/crew");
      expect(crew?.branch).toBe("main");
    } finally {
      await w.cleanup();
    }
  });
});

describe("AC-4 folders.browse — nothing above ~, no escapes (#238)", () => {
  it("every outside-home shape is refused with a clear error", async () => {
    const { home, outside } = seedHome();
    const w = await setupWorld(home);
    try {
      for (const path of [
        "/System",
        "/etc",
        outside,
        "~/../",
        "~/Documents/../../",
        "../",
        "~/outlink",
        "~/Documents/.hidden",
        "~/.ssh",
      ]) {
        const err = await errorOf(w.phone.request("folders.browse", { path }));
        expect(err.message, path).toContain("outside the Mac's home folder");
      }
    } finally {
      await w.cleanup();
    }
  });

  it("a missing folder under home is a not-found, not an escape", async () => {
    const { home } = seedHome();
    const w = await setupWorld(home);
    try {
      const err = await errorOf(
        w.phone.request("folders.browse", { path: "~/Documents/nope" }),
      );
      expect(err.message).toContain("no such folder");
    } finally {
      await w.cleanup();
    }
  });
});

describe("AC-3 Use → folders.add → recents on both surfaces → session cwd (#238)", () => {
  it("the picked folder lands in shared recents and the session runs there", async () => {
    const { home } = seedHome();
    const w = await setupWorld(home);
    try {
      // Use on a browsed folder = folders.add; the folder then shows in the
      // shared recents list (what the phone AND the web read).
      await w.phone.request("folders.add", { path: "~/repos/notes" });
      const { folders } = await w.phone.request<{
        folders: { path: string }[];
      }>("folders.list", {});
      expect(folders.map((f) => f.path)).toContain("~/repos/notes");

      // The recents-gated probe now answers for the added path.
      const detail = await w.phone.request<{ isRepo: boolean }>(
        "folders.detail",
        { path: "~/repos/notes" },
      );
      expect(detail.isRepo).toBe(true);

      // And a session opened in it lands on that cwd (direct pick).
      const { employee } = await w.phone.request<{ employee: { id: string } }>(
        "employees.create",
        { name: "Ada", role: "engineer", profile: "builder" },
      );
      const { channel } = await w.phone.request<{ channel: { id: string } }>(
        "channels.openDm",
        { employeeId: employee.id },
      );
      const { conversation } = await w.phone.request<{
        conversation: Conversation;
      }>("conversations.open", {
        channelId: channel.id,
        text: "ship it",
        cwd: "~/repos/notes",
      });
      await waitFor(async () => {
        const start = w.engineCalls
          .filter((c) => c.method === "session.start")
          .at(-1);
        return start?.params as { cwd?: string } | undefined;
      }, "session.start");
      expect(
        w.engineCalls.filter((c) => c.method === "session.start").at(-1)
          ?.params,
      ).toMatchObject({ cwd: join(home, "repos", "notes") });
    } finally {
      await w.cleanup();
    }
  });
});
