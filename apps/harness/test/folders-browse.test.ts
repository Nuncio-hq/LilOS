import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type RelayClient, RelayError } from "@lilos/client-runtime";
import type {
  Conversation,
  FoldersBrowseResult,
  FoldersDiscoverResult,
} from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { mkhome, setupWorld as setupWorldBase, waitFor } from "./helpers";

/* `folders.browse`/`folders.discover` (#238): the phone's folder browser,
   driven by a device-scope client over a real relay + harness + tmpdir
   "home" on disk. The home-folder boundary is enforced by the harness
   (server-side) — every escape shape is refused before any listing. The
   pick then lands via `folders.add` and a session in it proves the cwd. */

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

/* The phone: a paired device peer, like the real app (#153). */
async function setupWorld(home: string) {
  const w = await setupWorldBase({
    homeDir: home,
    pairing: true,
    phone: true,
    workdir: join(home, "work"),
    reconnectMinDelayMs: 20,
  });
  return {
    store: w.store,
    engineCalls: w.engineCalls,
    harness: w.harness,
    phone: w.phone as RelayClient,
    cleanup: w.cleanup,
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
  const outside = mkhome();
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
      await w.phone.request<{ conversation: Conversation }>(
        "conversations.open",
        { channelId: channel.id, text: "ship it", cwd: "~/repos/notes" },
      );
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
