import type {
  AgentDescriptor,
  AgentsCreateParams,
  AgentsUpdateParams,
} from "@lilos/contracts/engine";
import { RPC_ERRORS } from "@lilos/contracts/engine";
import { RpcError } from "./errors.js";

/**
 * D-#845 — the seam's agent roster: the personas `agents.*` serves and
 * `session.start.agent` resolves. One ACP process is one agent binary —
 * the launch spec seeds the roster with that agent; `agents.create` adds
 * LilOS personas (a name, a soul, a model pin) the same binary then runs
 * sessions as. In-memory like the session map: LilOS owns the durable
 * employee record, and the harness's `ensureAgent` re-registers a persona
 * a restarted adapter forgot before the next `session.start`.
 *
 * `session.start` itself stays permissive — ACP has no profile gate on
 * `session/new`; the roster is what the agent's name means to LilOS
 * (model pin, soul record), never a refusal wall.
 */

/** The profile-slug rule the web hire dialog uses, shared so engine ids
    and client guesses agree (`hireEmployee` in apps/web). */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+|[-_]+$/g, "")
    .slice(0, 64);

export class AcpAgentRoster {
  private rows = new Map<string, AgentDescriptor>();

  /**
   * `seed` is the launched agent itself — the roster is never empty, so
   * `agents.list` always has the one hireable this engine runs.
   * `models` is a lazy read of the learned config catalog — it is empty
   * until a session has advertised config options.
   */
  constructor(
    seed: AgentDescriptor,
    private readonly models: () => { id: string }[],
  ) {
    this.rows.set(seed.id, { ...seed });
  }

  /** Roster rows stay light — the persona text is describe-only. */
  list(): AgentDescriptor[] {
    return [...this.rows.values()].map(({ soul: _soul, ...row }) => row);
  }

  describe(id: string): AgentDescriptor {
    const a = this.rows.get(id);
    if (!a) throw new RpcError(RPC_ERRORS.AGENT_NOT_FOUND, `no agent ${id}`);
    return { ...a };
  }

  /** The persona a `session.start.agent` resolves to, when known. */
  resolve(ref: string): AgentDescriptor | undefined {
    const want = ref.toLowerCase();
    return (
      this.rows.get(ref) ??
      [...this.rows.values()].find((a) => a.name.toLowerCase() === want)
    );
  }

  /** Model ids validate against the learned catalog when there is one —
      an empty catalog (no session has advertised yet) cannot refuse. */
  private checkModel(model: string | undefined) {
    if (model === undefined) return;
    const known = this.models();
    if (known.length > 0 && !known.some((m) => m.id === model))
      throw new RpcError(
        RPC_ERRORS.MODEL_NOT_FOUND,
        `no model ${model} — see models.list`,
      );
  }

  create(p: AgentsCreateParams): AgentDescriptor {
    if (
      [...this.rows.values()].some(
        (a) => a.name.toLowerCase() === p.name.toLowerCase(),
      )
    )
      throw new RpcError(
        RPC_ERRORS.INVALID_STATE,
        `agent ${p.name} already exists`,
      );
    this.checkModel(p.model);
    const base = slug(p.name) || "agent";
    let id = base;
    for (let n = 2; this.rows.has(id); n++) id = `${base}-${n}`;
    const agent: AgentDescriptor = {
      id,
      name: p.name,
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.model !== undefined ? { model: p.model } : {}),
      ...(p.soul !== undefined ? { soul: p.soul } : {}),
    };
    this.rows.set(id, agent);
    return { ...agent };
  }

  /** Rewrite persona fields in place — the id never moves. New sessions
      read the updated row at `session.start`; running sessions keep the
      snapshot they started with. */
  update(p: AgentsUpdateParams): AgentDescriptor {
    const a = this.rows.get(p.id);
    if (!a) throw new RpcError(RPC_ERRORS.AGENT_NOT_FOUND, `no agent ${p.id}`);
    this.checkModel(p.model);
    if (p.name !== undefined) a.name = p.name;
    if (p.description !== undefined) a.description = p.description;
    if (p.soul !== undefined) a.soul = p.soul;
    if (p.model !== undefined) a.model = p.model;
    return { ...a };
  }
}
