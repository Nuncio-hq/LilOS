import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";
import {
  type AcpSessionConfig,
  catalogEffortOption,
  catalogFastOption,
  catalogModelOption,
  catalogModels,
  configOptionDescriptor,
  deriveCapabilities,
  learnSessionConfig,
} from "../src/capabilities.js";

/** A session/new shape like the fake agent (and `devin acp`) advertises. */
const sessionAd = (
  over: Partial<acp.NewSessionResponse> = {},
): Pick<acp.NewSessionResponse, "configOptions" | "modes"> => ({
  modes: {
    currentModeId: "ask",
    availableModes: [
      { id: "ask", name: "Ask" },
      { id: "code", name: "Code" },
    ],
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "m-small",
      options: [
        { value: "m-small", name: "Small" },
        { value: "m-large", name: "Large" },
      ],
    },
    {
      id: "thought_level",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: ["low", "medium", "high"].map((v) => ({
        value: v,
        name: v,
      })),
    },
    {
      id: "speed",
      name: "Speed",
      category: "model_config",
      type: "select",
      currentValue: "standard",
      options: [
        { value: "standard", name: "Standard" },
        { value: "fast", name: "Fast" },
      ],
    },
  ] as acp.SessionConfigOption[],
  ...over,
});

const init = (
  caps: Partial<acp.AgentCapabilities> = {},
): Pick<
  acp.InitializeResponse,
  "protocolVersion" | "agentCapabilities" | "agentInfo"
> => ({
  protocolVersion: 1,
  agentInfo: { name: "some-agent", version: "0" },
  agentCapabilities: caps,
});

const learned = (): AcpSessionConfig => {
  const c: AcpSessionConfig = { options: new Map() };
  learnSessionConfig(c, sessionAd());
  return c;
};

describe("config option -> engine descriptors (D-#764)", () => {
  test("a select option flattens groups and carries the current value", () => {
    const d = configOptionDescriptor({
      id: "model",
      category: "model",
      type: "select",
      currentValue: "m1",
      options: [
        {
          group: "g",
          name: "Group",
          options: [
            { value: "m1", name: "One" },
            { value: "m2", name: "Two", description: "bigger" },
          ],
        },
        { value: "m3", name: "Three" },
      ],
    } as acp.SessionConfigOption);
    expect(d.type).toBe("select");
    expect(d.currentValue).toBe("m1");
    expect(d.choices.map((c) => c.value)).toEqual(["m1", "m2", "m3"]);
  });

  test("a boolean option normalizes to true/false choices", () => {
    const d = configOptionDescriptor({
      id: "turbo",
      category: "model_config",
      type: "boolean",
      currentValue: true,
    } as acp.SessionConfigOption);
    expect(d.type).toBe("boolean");
    expect(d.currentValue).toBe("true");
  });
});

describe("learned catalog -> model/effort/fast descriptors", () => {
  test("models.list rows come only from category:model options", () => {
    const rows = catalogModels(learned());
    expect(rows.map((m) => m.id)).toEqual(["m-small", "m-large"]);
    /* thought_level becomes the shared effort ladder on every row. */
    expect(rows[0].efforts).toEqual(["low", "medium", "high"]);
    expect(rows[0].defaultEffort).toBe("medium");
    /* a model_config select offering "fast" marks rows fast:true. */
    expect(rows[0].fast).toBe(true);
  });

  test("category lookups find the model/effort/fast write targets", () => {
    const c = learned();
    expect(catalogModelOption(c)?.id).toBe("model");
    expect(catalogEffortOption(c)?.id).toBe("thought_level");
    expect(catalogFastOption(c)).toMatchObject({
      option: { id: "speed" },
      fastValue: "fast",
    });
  });

  test("a boolean model_config option is the fast switch too", () => {
    const c: AcpSessionConfig = { options: new Map() };
    learnSessionConfig(
      c,
      sessionAd({
        configOptions: [
          {
            id: "turbo",
            category: "model_config",
            type: "boolean",
            currentValue: false,
          },
        ] as acp.SessionConfigOption[],
      }),
    );
    expect(catalogFastOption(c)).toMatchObject({ fastValue: "true" });
  });
});

describe("deriveCapabilities — advertisement-driven, never name-driven", () => {
  test("the base rows every ACP agent gets (protocol surface)", () => {
    const caps = deriveCapabilities(init(), { options: new Map() });
    const ids = caps.map((c) => c.id);
    /* Queue-as-next-prompt steer, unconditional MCP attach, plan frames,
       usage, engine-side titles, and the opaque acp row — all independent
       of what initialize advertised beyond the ACP protocol itself. */
    for (const id of [
      "steer",
      "mcp_servers",
      "plan",
      "usage",
      "session_meta",
      "acp",
    ])
      expect(ids).toContain(id);
    /* Features ACP lacks are absent — never faked (D-#19). */
    for (const id of [
      "rewind",
      "compact",
      "workspace_move",
      "approval_policy",
      "agents",
      "subagents",
      "background_jobs",
      "image_prompt",
      "models",
    ])
      expect(ids).not.toContain(id);
  });

  test("image_prompt appears only when promptCapabilities.image is true", () => {
    const withImage = deriveCapabilities(
      init({ promptCapabilities: { image: true } }),
      { options: new Map() },
    );
    const without = deriveCapabilities(
      init({ promptCapabilities: { image: false } }),
      { options: new Map() },
    );
    expect(withImage.map((c) => c.id)).toContain("image_prompt");
    expect(without.map((c) => c.id)).not.toContain("image_prompt");
  });

  test("mcp transports reflect mcpCapabilities", () => {
    const caps = deriveCapabilities(
      init({ mcpCapabilities: { http: true, sse: true } }),
      { options: new Map() },
    );
    const mcp = caps.find((c) => c.id === "mcp_servers");
    expect(mcp?.detail?.transports).toEqual(["stdio", "http", "sse"]);
  });

  test("the models capability joins only once a session advertised models", () => {
    const before = deriveCapabilities(init(), { options: new Map() });
    expect(before.map((c) => c.id)).not.toContain("models");
    const after = deriveCapabilities(init(), learned());
    expect(after.map((c) => c.id)).toContain("models");
    const models = after.find((c) => c.id === "models");
    expect(models?.methods).toEqual(["models.list", "session.setModel"]);
    expect(models?.detail?.effort).toBe(true);
    expect(models?.detail?.fast).toBe(true);
    expect(models?.detail?.modes).toMatchObject([
      { id: "ask" },
      { id: "code" },
    ]);
    expect(models?.detail?.currentMode).toBe("ask");
  });

  test("the acp row reports the pin, the protocol version, and the catalog", () => {
    const caps = deriveCapabilities(init({ loadSession: true }), learned());
    const row = caps.find((c) => c.id === "acp");
    expect(row?.detail?.schemaRelease).toBe("schema-v1.26.0");
    expect(row?.detail?.protocolVersion).toBe(1);
    expect(row?.detail?.loadSession).toBe(true);
    const opts = row?.detail?.configOptions as { id: string }[];
    expect(opts.map((o) => o.id)).toEqual(["model", "thought_level", "speed"]);
  });

  test("two agents advertising the same flags describe identically", () => {
    const caps = {
      loadSession: true,
      promptCapabilities: { image: true },
      mcpCapabilities: { http: true },
    };
    const a = deriveCapabilities(
      {
        protocolVersion: 1,
        agentInfo: { name: "hermes", version: "1" },
        agentCapabilities: caps,
      },
      learned(),
    );
    const b = deriveCapabilities(
      {
        protocolVersion: 1,
        agentInfo: { name: "devin", version: "9" },
        agentCapabilities: caps,
      },
      learned(),
    );
    expect(a).toEqual(b);
  });
});
