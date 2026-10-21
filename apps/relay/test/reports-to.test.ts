/** D-#775 on the real store: reports_to round-trips, null comes back absent,
    and removing a manager clears dependents (foreign keys are on). The wire
    tests run the memory store, so the SQL null and the FK only show here.
    Runs under bun:sqlite via a subprocess (vitest itself is Node). */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BUN, RELAY_DIR } from "./helpers";

const SCRIPT = `
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
const linked = await s.updateEmployee(bea.id, { reportsTo: ada.id });
const cleared = await s.updateEmployee(bea.id, { reportsTo: null });
await s.updateEmployee(bea.id, { reportsTo: ada.id });
await s.removeEmployee(ada.id);
const after = await s.getEmployee(bea.id);
console.log(JSON.stringify({
  version: db.query("PRAGMA user_version").get().user_version,
  linked: linked?.reportsTo ?? null,
  cleared: cleared?.reportsTo ?? null,
  after: after?.reportsTo ?? null,
}));
`;

describe("reportsTo on the real store (D-#775)", () => {
  it("stores an employee id, omits null, and clears dependents on remove", () => {
    const run = spawnSync(BUN, ["-e", SCRIPT], {
      cwd: RELAY_DIR,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null") as {
      version: number;
      linked: string | null;
      cleared: string | null;
      after: string | null;
    };
    expect(out.version).toBe(33);
    expect(out.linked).toMatch(/^emp_/);
    expect(out.cleared).toBeNull();
    expect(out.after).toBeNull();
  });
});
