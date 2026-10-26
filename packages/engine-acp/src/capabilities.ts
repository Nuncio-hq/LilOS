import type * as acp from "@agentclientprotocol/sdk";
import {
  type Capability,
  IMAGE_PROMPT_CAPABILITY,
  type ModelOption,
  PLAN_CAPABILITY,
  SESSION_META_CAPABILITY,
  STEER_CAPABILITY,
} from "@lilos/contracts/engine";
import { ACP_SCHEMA_RELEASE } from "./pin.js";

/**
 * D-#764 — ACP `initialize` capabilities -> LilOS capability descriptors,
 * shared by every ACP runtime. The rule is strict: a capability exists
 * only when the agent advertised it (or the protocol makes it possible for
 * every agent — a `session/new` accepts `mcpServers` unconditionally, any
 * agent may stream `plan`/`usage_update` frames). Features ACP lacks
 * (history rewind, workspace move, engine-side titles, a global approval
 * policy) are declared absent — never faked (D-#19). Nothing here reads an
 * agent name: two agents advertising the same flags describe identically.
 */

/**
 * Session-level knowledge the agent reveals only through `session/new`
 * (config options, modes). It accrues on the engine as sessions open — the
 * first describe may legitimately lack it; by the second it is truth.
 */
export interface AcpSessionConfig {
  /** Normalized config-option descriptors, keyed by option id. */
  options: Map<string, EngineConfigOption>;
  /** `SessionModeState`-derived mode list, when the session advertised one. */
  modes?: { current: string; available: { id: string; name?: string }[] };
}

/** One agent-advertised config option, normalized into descriptor shape. */
export interface EngineConfigOption {
  id: string;
  /** ACP category: "model" | "mode" | "model_config" | "thought_level" | other. */
  category: string;
  name?: string;
  type: "select" | "boolean";
  /** Current value id ("true"/"false" strings for booleans). */
  currentValue?: string;
  choices: { value: string; name?: string; description?: string }[];
}

const flatOptions = (
  opts: acp.SessionConfigSelectOptions,
): { value: string; name?: string; description?: string }[] => {
  const out: { value: string; name?: string; description?: string }[] = [];
  for (const o of opts) {
    if ("options" in o) out.push(...flatOptions(o.options));
    else
      out.push({
        value: o.value,
        ...(o.name ? { name: o.name } : {}),
        ...(o.description ? { description: o.description } : {}),
      });
  }
  return out;
};

/**
 * One ACP `SessionConfigOption` -> the engine descriptor shape — models,
 * efforts (`thought_level`), fast tiers (`model_config`), modes and the
 * generic rest all ride the same row; per-job selection is #846.
 */
export function configOptionDescriptor(
  o: acp.SessionConfigOption,
): EngineConfigOption {
  if (o.type === "boolean") {
    return {
      id: o.id,
      category: o.category ?? "general",
      ...(o.name ? { name: o.name } : {}),
      type: "boolean",
      currentValue: o.currentValue === true ? "true" : "false",
      choices: [
        { value: "true", name: "On" },
        { value: "false", name: "Off" },
      ],
    };
  }
  return {
    id: o.id,
    category: o.category ?? "general",
    ...(o.name ? { name: o.name } : {}),
    type: "select",
    ...(o.currentValue !== undefined
      ? { currentValue: String(o.currentValue) }
      : {}),
    choices: flatOptions(o.options ?? []),
  };
}

/**
 * Fold one `session/new` response into the engine's learned config catalog.
 * Returns the session-scoped view (the catalog itself is engine-wide truth
 * — two sessions advertising different models still union into it).
 */
export function learnSessionConfig(
  catalog: AcpSessionConfig,
  res: Pick<acp.NewSessionResponse, "configOptions" | "modes">,
): void {
  for (const o of res.configOptions ?? []) {
    catalog.options.set(o.id, configOptionDescriptor(o));
  }
  if (res.modes) {
    catalog.modes = {
      current: res.modes.currentModeId,
      available: res.modes.availableModes.map((m) => ({
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
      })),
    };
  }
}

/** Options of one ACP category, in advertisement order. */
export function configByCategory(
  catalog: AcpSessionConfig,
  category: string,
): EngineConfigOption[] {
  return [...catalog.options.values()].filter((o) => o.category === category);
}

/**
 * `models.list` rows off the learned catalog: one ModelOption per
 * `category:"model"` choice. `thought_level` options become the shared
 * effort ladder on every row (ACP applies the level agent-wide; the row's
 * `defaultEffort` is the current value). A `model_config` option offering
 * a fast tier marks rows `fast: true`.
 */
export function catalogModels(catalog: AcpSessionConfig): ModelOption[] {
  const models = configByCategory(catalog, "model");
  const efforts = configByCategory(catalog, "thought_level").flatMap(
    (o) => o.choices,
  );
  const currentEffort = configByCategory(catalog, "thought_level").find(
    (o) => o.currentValue,
  )?.currentValue;
  const fast = catalogHasFast(catalog);
  const rows: ModelOption[] = [];
  for (const m of models) {
    for (const c of m.choices) {
      rows.push({
        id: c.value,
        ...(c.name ? { name: c.name } : {}),
        ...(efforts.length
          ? {
              efforts: efforts.map((e) => e.value),
              ...(currentEffort ? { defaultEffort: currentEffort } : {}),
            }
          : {}),
        ...(fast ? { fast: true } : {}),
        ...(c.description ? { detail: { description: c.description } } : {}),
      });
    }
  }
  return rows;
}

/** The `thought_level` option the session writes an effort pick through. */
export function catalogEffortOption(
  catalog: AcpSessionConfig,
): EngineConfigOption | undefined {
  return configByCategory(catalog, "thought_level")[0];
}

/** The `model` option a session.setModel writes through. */
export function catalogModelOption(
  catalog: AcpSessionConfig,
): EngineConfigOption | undefined {
  return configByCategory(catalog, "model")[0];
}

/**
 * A `model_config` select offering a fast tier (e.g. standard/fast) or a
 * boolean under the same category — the agent's fast/priority switch.
 */
export function catalogFastOption(
  catalog: AcpSessionConfig,
): { option: EngineConfigOption; fastValue: string } | undefined {
  for (const o of configByCategory(catalog, "model_config")) {
    if (o.type === "boolean") return { option: o, fastValue: "true" };
    const fast = o.choices.find((c) => c.value === "fast");
    if (fast) return { option: o, fastValue: "fast" };
  }
  return undefined;
}

export function catalogHasFast(catalog: AcpSessionConfig): boolean {
  return catalogFastOption(catalog) !== undefined;
}

/**
 * Capability descriptors from `initialize` + the learned session config.
 * `learned` may be empty — describe() then reports only what the handshake
 * itself promised; the models surface joins in once a session has
 * advertised a `model` config option.
 */
export function deriveCapabilities(
  init: Pick<
    acp.InitializeResponse,
    "protocolVersion" | "agentCapabilities" | "agentInfo"
  >,
  learned: AcpSessionConfig,
): Capability[] {
  const caps: Capability[] = [];
  const ac = init.agentCapabilities ?? {};
  const prompt = ac.promptCapabilities ?? {};
  const mcp = ac.mcpCapabilities ?? {};

  /* Queue-as-next-prompt steering: ACP has no mid-turn injection, so a
     steer during a running turn is accepted and pumped as the following
     `session/prompt` — `turn.steered` marks the acceptance, the next
     turn's `turn.started` carries it. */
  caps.push({ ...STEER_CAPABILITY });

  if (prompt.image === true) caps.push({ ...IMAGE_PROMPT_CAPABILITY });

  /* `session/new` accepts `mcpServers` unconditionally — the capability
     detail names which transports the initialize handshake advertised
     (stdio is the protocol's baseline). */
  const transports = [
    "stdio",
    ...(mcp.http === true ? ["http"] : []),
    ...(mcp.sse === true ? ["sse"] : []),
  ];
  caps.push({
    id: "mcp_servers",
    name: "MCP servers",
    description:
      "session.start mcpServers ride the ACP session/new attach; transports are what initialize advertised.",
    methods: ["session.start"],
    detail: { transports },
  });

  /* #180: any ACP agent may stream `plan` updates — declared so the client
     renders the task list when one arrives; there is no proposal surface on
     ACP, so proposals:false (a plan request is not openable). */
  caps.push({ ...PLAN_CAPABILITY, detail: { proposals: false } });

  /* Rename/hide are engine-side session state; the agent's
     session_info_update.title feeds the llm auto-title stage — both exist
     for every ACP agent, so session_meta always declares. */
  caps.push({ ...SESSION_META_CAPABILITY });

  /* usage_update ticks + PromptResponse.usage are protocol surface every
     agent may send — no methods, the meter reads turn.completed.usage. */
  caps.push({
    id: "usage",
    name: "Usage accounting",
    description:
      "turn.completed carries per-turn token usage; usage_update ticks report context occupancy.",
  });

  /* Model/effort/mode descriptors exist only once a session has
     advertised them — configOptions are a session/new surface, never an
     initialize one. */
  const models = catalogModels(learned);
  if (models.length) {
    caps.push({
      id: "models",
      name: "Model picker",
      description:
        "models.list flattens the agent's model config options; session.setModel writes session/set_config_option.",
      methods: ["models.list", "session.setModel"],
      detail: {
        effort: catalogEffortOption(learned) !== undefined,
        fast: catalogHasFast(learned),
        ...(learned.modes
          ? {
              modes: learned.modes.available.map((m) => ({
                id: m.id,
                ...(m.name ? { name: m.name } : {}),
              })),
              currentMode: learned.modes.current,
            }
          : {}),
      },
    });
  }

  /* The opaque ACP detail row: the pin this seam speaks plus the session
     config catalog (config options/modes) a generic client can render
     without knowing the agent. */
  caps.push({
    id: "acp",
    name: "ACP agent",
    description:
      "Speaks ACP over the pinned schema release; capabilities derive only from what initialize/session.new advertise.",
    detail: {
      schemaRelease: ACP_SCHEMA_RELEASE,
      protocolVersion: init.protocolVersion,
      loadSession: ac.loadSession === true,
      sessionCapabilities: {
        ...(ac.sessionCapabilities?.list !== undefined ? { list: true } : {}),
        ...(ac.sessionCapabilities?.resume !== undefined
          ? { resume: true }
          : {}),
        ...(ac.sessionCapabilities?.fork !== undefined ? { fork: true } : {}),
        ...(ac.sessionCapabilities?.close !== undefined ? { close: true } : {}),
        ...(ac.sessionCapabilities?.delete !== undefined
          ? { delete: true }
          : {}),
      },
      configOptions: [...learned.options.values()].map((o) => ({
        id: o.id,
        category: o.category,
        ...(o.name ? { name: o.name } : {}),
        type: o.type,
        ...(o.currentValue !== undefined
          ? { currentValue: o.currentValue }
          : {}),
        choices: o.choices,
      })),
    },
  });

  return caps;
}
