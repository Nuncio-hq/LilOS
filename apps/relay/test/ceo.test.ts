/**
 * D-#778: company.setCeo is one write. The memory store covers the wire
 * (events, the settings-key lock). The drizzle subprocess covers the
 * real transaction and that user_version stays 31 — migration 32 is #776's.
 */

import { spawnSync } from "node:child_process";
import { CEO_SETTING_KEY } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import {
  BUN,
  eventsNamed,
  helloed,
  lastId,
  newRelay,
  RELAY_DIR,
  req,
  resultOf,
  tick,
} from "./helpers";

describe("company.setCeo (D-#778)", () => {
  it("sets ceoId, re-points reportsTo, and rejects a bare settings.set", async () => {
    const relay = newRelay();
    const user = await helloed(relay);
    const hire = async (name: string) => {
      await user.connection.receive(
        req("employees.create", { name, role: "eng" }),
      );
      await tick();
      return (
        resultOf(user.frames, lastId()).result as {
          employee: { id: string; reportsTo?: string };
        }
      ).employee;
    };
    const ada = await hire("Ada");
    const bea = await hire("Bea");
    const cio = await hire("Cio");
    await user.connection.receive(
      req("employees.update", { id: cio.id, reportsTo: bea.id }),
    );
    await tick();
    user.frames.length = 0;

    await user.connection.receive(
      req("company.setCeo", { employeeId: ada.id }),
    );
    await tick();
    const first = resultOf(user.frames, lastId()).result as {
      ceoId: string;
      employees: { id: string; reportsTo?: string }[];
    };
    expect(first.ceoId).toBe(ada.id);
    expect(first.employees.find((e) => e.id === bea.id)?.reportsTo).toBe(
      ada.id,
    );
    expect(first.employees.find((e) => e.id === ada.id)).toBeUndefined();
    expect(eventsNamed(user.frames, "settings.changed")).toEqual([
      expect.objectContaining({
        params: { key: CEO_SETTING_KEY, value: ada.id },
      }),
    ]);
    expect(
      eventsNamed(user.frames, "employee.upserted").map(
        (e) =>
          (e as { params: { employee: { id: string } } }).params.employee.id,
      ),
    ).toContain(bea.id);

    user.frames.length = 0;
    await user.connection.receive(
      req("company.setCeo", { employeeId: bea.id }),
    );
    await tick();
    const second = resultOf(user.frames, lastId()).result as {
      ceoId: string;
      employees: { id: string; reportsTo?: string }[];
    };
    expect(second.ceoId).toBe(bea.id);
    const byId = new Map(second.employees.map((e) => [e.id, e.reportsTo]));
    expect(byId.get(ada.id)).toBe(bea.id);
    expect(byId.has(bea.id)).toBe(true);
    expect(byId.get(bea.id)).toBeUndefined();
    /* Cio already reported to Bea, so that link is not rewritten. */
    expect(byId.has(cio.id)).toBe(false);

    user.frames.length = 0;
    await user.connection.receive(
      req("settings.set", { key: CEO_SETTING_KEY, value: ada.id }),
    );
    await tick();
    const denied = resultOf(user.frames, lastId()) as {
      error?: { data?: { code?: string } };
    };
    expect(denied.error?.data?.code).toBe("invalid_params");

    user.frames.length = 0;
    await user.connection.receive(
      req("company.setCeo", { employeeId: "emp_missing" }),
    );
    await tick();
    const missing = resultOf(user.frames, lastId()) as {
      error?: { data?: { code?: string } };
    };
    expect(missing.error?.data?.code).toBe("not_found");
  });
});

const DRIZZLE = `
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createDrizzleStore } from "./src/db/drizzle-store.ts";
import { applyMigrations } from "./src/db/migrate.ts";
import * as schema from "./src/db/schema.ts";

const db = new Database(":memory:");
applyMigrations(db);
const s = createDrizzleStore(drizzle(db, { schema }));
const hire = (name) => s.createEmployee({
  name, role: "eng", status: "online", profile: "default",
  model: "", now: "", instructions: "", respondTo: "me",
});
const ada = await hire("Ada");
const bea = await hire("Bea");
const cio = await hire("Cio");
await s.updateEmployee(cio.id, { reportsTo: bea.id });
const first = await s.setCeo(ada.id);
const again = await s.setCeo(ada.id);
const second = await s.setCeo(bea.id);
const rows = await s.listEmployees();
console.log(JSON.stringify({
  version: db.query("PRAGMA user_version").get().user_version,
  first: first.employees.map((e) => [e.id === ada.id ? "ada" : e.id === bea.id ? "bea" : "cio", e.reportsTo ?? null]),
  again: again.changed,
  second: second.employees.map((e) => [e.id === ada.id ? "ada" : e.id === bea.id ? "bea" : "cio", e.reportsTo ?? null]),
  ceo: await s.getSetting("ceoId"),
  cio: rows.find((e) => e.id === cio.id)?.reportsTo === bea.id,
}));
`;

describe("company.setCeo on the real store (D-#778)", () => {
  it("writes ceoId and reportsTo in one transaction without a migration", () => {
    const run = spawnSync(BUN, ["-e", DRIZZLE], {
      cwd: RELAY_DIR,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null") as {
      version: number;
      first: [string, string | null][];
      again: boolean;
      second: [string, string | null][];
      ceo: string;
      cio: boolean;
    };
    expect(out.version).toBe(31);
    expect(out.first).toContainEqual(["bea", expect.stringMatching(/^emp_/)]);
    expect(out.again).toBe(false);
    expect(out.second).toContainEqual(["ada", expect.stringMatching(/^emp_/)]);
    expect(out.second).toContainEqual(["bea", null]);
    expect(out.second.some((row) => row[0] === "cio")).toBe(false);
    expect(out.ceo).toMatch(/^emp_/);
    expect(out.cio).toBe(true);
  });
});
