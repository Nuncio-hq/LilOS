import { describe, expect, test } from "vitest";
import { AcpAgentRoster } from "../src/agents.js";
import type { RpcError } from "../src/errors.js";

/**
 * The roster that carries `agents.*` over the seam (D-#845): the launch's
 * own agent is the seed, `agents.create` adds LilOS personas the same
 * binary runs as. `session.start` stays permissive (the roster is not a
 * gate — ACP `session/new` takes no profile), so these tests pin the
 * store's behavior, not start-time refusal.
 */
const SEED = {
  id: "devin",
  name: "Devin",
  description: "the launched agent",
  detail: { isDefault: true },
};

const make = (models: { id: string }[] = []) =>
  new AcpAgentRoster(SEED, () => models);

describe("AcpAgentRoster (D-#845)", () => {
  test("the launch seed opens the roster; list rows stay light", () => {
    const r = make();
    expect(r.list().map((a) => a.id)).toEqual(["devin"]);
    expect(r.list()[0].soul).toBeUndefined();
    expect(r.describe("devin").detail?.isDefault).toBe(true);
  });

  test("create registers a persona list + describe see; duplicates refuse", () => {
    const r = make();
    const a = r.create({
      name: "Builder Bot",
      description: "persona",
      soul: "Be terse.",
    });
    expect(a.id).toBe("builder-bot");
    expect(r.list().map((x) => x.id)).toEqual(["devin", "builder-bot"]);
    expect(r.describe("builder-bot").soul).toBe("Be terse.");
    try {
      r.create({ name: "builder bot" });
      expect.unreachable("duplicate name should throw");
    } catch (e) {
      expect((e as RpcError).code).toBe(-32003);
    }
  });

  test("ids suffix when the slug is taken by a different name", () => {
    const r = make();
    const a = r.create({ name: "Devin!" });
    expect(a.id).toBe("devin-2");
  });

  test("update rewrites persona fields; a forgotten persona is restored", () => {
    const r = make();
    const a = r.create({ name: "Builder Bot", soul: "v1" });
    const u = r.update({ id: a.id, soul: "v2", description: "d2" });
    expect(u.soul).toBe("v2");
    expect(r.describe(a.id).soul).toBe("v2");
    expect(r.describe(a.id).description).toBe("d2");
    /* #872: the roster is in-memory — a restart forgets personas while the
       relay record keeps them. `agents.update` is then the restore path:
       it re-materialises the row from the patch instead of erroring
       "no agent" while the record still says the agent exists. */
    const back = r.update({ id: "nope", name: "Nope", description: "d" });
    expect(back.id).toBe("nope");
    expect(r.describe("nope").description).toBe("d");
    try {
      r.describe("nobody");
      expect.unreachable();
    } catch (e) {
      expect((e as RpcError).code).toBe(-32004);
    }
  });

  test("model pins validate against the learned catalog only when non-empty", () => {
    const empty = make();
    const a = empty.create({ name: "Bot", model: "anything" });
    expect(a.model).toBe("anything");
    const known = make([{ id: "m1" }, { id: "m2" }]);
    expect(() => known.create({ name: "X", model: "nope" })).toThrowError(
      expect.objectContaining({ code: -32005 }) as never,
    );
    const b = known.create({ name: "Y", model: "m2" });
    expect(b.model).toBe("m2");
    expect(() => known.update({ id: b.id, model: "nope" })).toThrowError(
      expect.objectContaining({ code: -32005 }) as never,
    );
  });

  test("resolve finds a persona by id or case-insensitive name", () => {
    const r = make();
    r.create({ name: "Builder Bot" });
    expect(r.resolve("devin")?.id).toBe("devin");
    expect(r.resolve("Builder Bot")?.id).toBe("builder-bot");
    expect(r.resolve("builder bot")?.id).toBe("builder-bot");
    expect(r.resolve("stranger")).toBeUndefined();
  });
});
