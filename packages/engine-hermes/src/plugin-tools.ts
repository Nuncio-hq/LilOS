/**
 * #549 — the `lilos` plugin's tools reaching a LilOS session on OUR backend.
 *
 * `hermes -p <p> plugins enable lilos` performs two writes: it persists the
 * profile's `plugins.enabled` entry AND nudges the running backend to load
 * the plugin now (`plugins_activation.notify_serve_backend`). The nudge is
 * routed through the host rendezvous record — the single machine-level
 * `hermes serve` that OWNS this OS user. When LilOS's backend runs
 * `--isolated` (#548: another app already owns the record), it is
 * observe-only precisely because it published no record — so the nudge
 * lands on the OTHER app's backend and our plugin never registers. The
 * session then offers "For 'lilos': NONE" while the config says enabled.
 *
 * The embedding app cannot fix the routing (the record is upstream's),
 * but it doesn't need it: the same activate verb — POST
 * /api/dashboard/agent-plugins/activate {name, home}, token-gated — can be
 * aimed at OUR OWN backend's address, which we have in the serve handle.
 *
 * Ordering matters twice over:
 *  - a session pins its model-facing tool list when its agent is built at
 *    `session.create`/`session.resume` — activation AFTER create leaves
 *    this session's `tools[]` without lilos_* even though wire `tools.list`
 *    (resolved live) already shows them. So the backend-level check+activate
 *    (`ensureLilosBackend`) runs BEFORE the session is created/resumed;
 *  - the session-scoped `tools.list` verify + offered-tools log
 *    (`logSessionTools`) runs right after, both as the AC-3 evidence line
 *    and as the diagnostic when the model-facing list still lacks lilos_*.
 */

import type { GatewayLike } from "./gateway.js";

export const LILOS_PLUGIN = "lilos";

/** One row of the wire `plugins.list` result — the backend plugin
    manager's loaded set, session-independent. */
export interface PluginRow {
  name: string;
  version?: string;
  enabled?: boolean;
}

/** One row of the wire `tools.list`/`toolsets.list` result. */
export interface ToolsetRow {
  name: string;
  enabled?: boolean;
  tools?: string[];
}

export interface PluginToolsDeps {
  log: (line: string) => void;
  /** Injectable fetch — tests point it at a stub; default global. */
  fetchFn?: typeof fetch;
}

/** The profile home Hermes' activate endpoint expects for `agent`
    (`profile_name_for_home` on the server side maps it back). */
export function profileHomeFor(agent: string, hermesHome: string): string {
  return agent === "default" ? hermesHome : `${hermesHome}/profiles/${agent}`;
}

async function backendPlugins(gw: GatewayLike): Promise<PluginRow[]> {
  const r = (await gw.request("plugins.list", {})) as {
    plugins?: PluginRow[];
  };
  return r.plugins ?? [];
}

/**
 * `tools.list {session_id}` — the toolsets a session resolves, with their
 * resolved tool names. Returns the offered names plus the lilos toolset's
 * own state so callers can both log the list and verify the plugin landed.
 */
export async function sessionTools(
  gw: GatewayLike,
  runtimeSid: string,
): Promise<{ names: string[]; lilosEnabled: boolean; lilosTools: string[] }> {
  const r = (await gw.request("tools.list", { session_id: runtimeSid })) as {
    toolsets?: ToolsetRow[];
  };
  const rows = r.toolsets ?? [];
  const names = rows
    .filter((t) => t.enabled !== false)
    .flatMap((t) => t.tools ?? []);
  const lilos = rows.find((t) => t.name === LILOS_PLUGIN);
  return {
    names,
    lilosEnabled: lilos?.enabled === true,
    lilosTools: lilos?.tools ?? [],
  };
}

/**
 * POST {name, home} to the backend's dashboard activate endpoint. False on
 * any transport failure or non-2xx — the caller logs and continues.
 */
export async function activateOnBackend(
  backend: { url: string; token: string },
  plugin: string,
  home: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(
      `${backend.url}/api/dashboard/agent-plugins/activate`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Hermes-Session-Token": backend.token,
        },
        body: JSON.stringify({ name: plugin, home }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Pre-session heal for #549: is `lilos` loaded in OUR backend's plugin
 * manager? If not, POST activate on OUR OWN backend — bypassing the
 * record-routed nudge entirely — and re-check. Never throws: a backend
 * without the endpoint (older Hermes) or a refused activate is a logged
 * miss, and the session still starts (it just lacks lilos_* and the
 * post-create `logSessionTools` line names that).
 */
export async function ensureLilosBackend(opts: {
  gw: GatewayLike;
  agent: string;
  hermesHome: string;
  backend?: { url: string; token: string };
  deps: PluginToolsDeps;
}): Promise<void> {
  const { gw, agent, hermesHome, backend, deps } = opts;
  try {
    const before = await backendPlugins(gw);
    const row = before.find((p) => p.name === LILOS_PLUGIN);
    if (row && row.enabled !== false) {
      deps.log(`plugin 'lilos' is active on our backend (${agent})`);
      return;
    }
    if (!backend) {
      deps.log(
        `plugin 'lilos' is not active on our backend and no backend endpoint was provided — cannot activate it for profile ${agent}`,
      );
      return;
    }
    const home = profileHomeFor(agent, hermesHome);
    const posted = await activateOnBackend(
      backend,
      LILOS_PLUGIN,
      home,
      deps.fetchFn,
    );
    if (!posted) {
      deps.log(
        `backend at ${backend.url} has no agent-plugins/activate (or refused it) — 'lilos' stays unloaded for profile ${agent}`,
      );
      return;
    }
    const after = await backendPlugins(gw);
    const again = after.find((p) => p.name === LILOS_PLUGIN);
    if (again && again.enabled !== false) {
      /* The enable nudge was routed to the host owner's record — it
         activated the plugin on the WRONG backend; this load is ours. */
      deps.log(`plugin 'lilos' activated on our backend for profile ${agent}`);
    } else {
      deps.log(
        `activation returned but 'lilos' is still not loaded — does ${home}'s config plugins.enabled list 'lilos'?`,
      );
    }
  } catch (e) {
    deps.log(
      `lilos plugin check failed: ${e instanceof Error ? e.message : String(e)} — the session may lack lilos_*`,
    );
  }
}

/**
 * Post-session verify + AC-3 evidence: log the tool names the session was
 * offered, and name it when `lilos` still isn't among them.
 */
export async function logSessionTools(opts: {
  gw: GatewayLike;
  runtimeSid: string;
  agent: string;
  deps: PluginToolsDeps;
}): Promise<void> {
  const { gw, runtimeSid, agent, deps } = opts;
  try {
    const { names, lilosEnabled, lilosTools } = await sessionTools(
      gw,
      runtimeSid,
    );
    deps.log(
      `session ${runtimeSid} (${agent}) offered ${names.length} tools: ${names.join(" ")}`,
    );
    if (!(lilosEnabled && lilosTools.length > 0)) {
      deps.log(
        `session ${runtimeSid}: no lilos_* tools offered — the model cannot answer LilOS questions with its app tools`,
      );
    }
  } catch (e) {
    deps.log(
      `session ${runtimeSid}: offered-tools check failed (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}
