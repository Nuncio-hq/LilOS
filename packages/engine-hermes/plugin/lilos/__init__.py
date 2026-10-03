"""LilOS agent-gateway plugin for Hermes Agent (issue #339).

One small adapter, three jobs:

1. Register the LilOS gateway's catalog as ``lilos_<name>`` tools — the tool
   list lives in the LilOS contracts package; this plugin only renders what
   ``GET <gateway>/tools`` returns. Every tool call carries the Hermes
   session id so the gateway resolves the session's own scope.
2. Inject the versioned LilOS host policy into each LilOS session's system
   prompt (``register_system_prompt_section`` — rendered once per session
   and frozen, so it is cache-safe by construction).
3. Block Hermes' own ``browser_*`` tools inside LilOS sessions — agents
   browse through the session's LilOS browser instead, which Oscar can
   watch. ``web_search``/``web_extract`` stay allowed (read-only).

The plugin is inert outside LilOS: tools are only registered when the
gateway env is present on the ``hermes serve`` process
(``LILOS_SURFACES_URL`` + ``LILOS_ENGINE_TOKEN``, set by the LilOS harness),
and every ``lilos_*`` call is refused by a ``pre_tool_call`` veto (and the
handler) unless the calling session's source is ``lilos``.

Why refusal rather than hiding: under ``hermes serve`` every gateway
session on a profile shares one toolset selection (``_load_enabled_toolsets``
reads the ``cli`` platform config for all sessions) and ``model_tools``
memoizes tool definitions per (profile, enabled toolsets) — there is no
per-session tool surface within a profile, by Hermes design ("check_fn
answers reachability for the PROFILE it runs under"). The offer list is
therefore profile-wide; the enforceable boundary is the call, so that is
where the gate sits.
"""

import json
import os
import urllib.error
import urllib.request

ENV_URL = "LILOS_SURFACES_URL"
ENV_TOKEN = "LILOS_ENGINE_TOKEN"
SESSION_HEADER = "x-lilos-session"
LILOS_SOURCE = "lilos"
TOOL_PREFIX = "lilos_"
BROWSER_PREFIX = "browser_"
TOOLSET = "lilos"

# Filled by _catalog(); None until the first successful fetch.
_catalog_cache = None
# Session ids proven to have source "lilos" (sessions live for the process
# lifetime; a source never changes once minted).
_lilos_sessions = set()
# session_id -> rendered host policy text ("" = fetch failed or N/A).
_policies = {}

_TIMEOUT_S = 15


# ---------------------------------------------------------------- env/auth

def _env():
    """(url, engine_token) when the harness wired this serve, else None."""
    url = os.environ.get(ENV_URL, "").strip().rstrip("/")
    tok = os.environ.get(ENV_TOKEN, "").strip()
    return (url, tok) if url and tok else None


def _request(method, url, token, path, session=None, payload=None, timeout=_TIMEOUT_S):
    body = None if payload is None else json.dumps(payload).encode()
    headers = {"Authorization": f"Bearer {token}"}
    if session:
        headers[SESSION_HEADER] = session
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url + path, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
    return json.loads(raw) if raw else {}


def _catalog(env):
    """GET /tools with the engine token → the full catalog (all areas)."""
    global _catalog_cache
    if _catalog_cache is None:
        try:
            _catalog_cache = _request("GET", env[0], env[1], "/tools").get("tools") or []
        except Exception:
            _catalog_cache = []
    return _catalog_cache


# ----------------------------------------------------------- session gating

def _source_is_lilos(session_id):
    """True when this Hermes session was created with source=lilos.

    Order: (1) the process env — LilOS stamps ``HERMES_SESSION_SOURCE=lilos``
    on the hermes spawns it owns (the acp path; one session per spawn), and
    under serve the env is never set so it can't leak to plain sessions;
    (2) the bound session context var — serve binds it per session from
    ``session.create(source=...)``, and it WINS over the env fallback only
    because the env check above already ran; (3) the live session registry —
    pre_tool_call kwargs carry the stored session key and the context may
    not be bound on every path.
    """
    if os.environ.get("HERMES_SESSION_SOURCE") == LILOS_SOURCE:
        return True
    try:
        from gateway.session_context import get_session_env
        src = str(get_session_env("HERMES_SESSION_SOURCE") or "")
        if src:
            return src == LILOS_SOURCE
    except Exception:
        pass
    if not session_id:
        return False
    if session_id in _lilos_sessions:
        return True
    try:
        from tui_gateway import server as _srv
        for sess in _srv._sessions.values():
            keys = {
                sess.get("session_key"),
                getattr(sess.get("agent"), "session_id", None),
            }
            if session_id in keys:
                if sess.get("source") == LILOS_SOURCE:
                    _lilos_sessions.add(session_id)
                    return True
                return False
    except Exception:
        pass
    return False


def _profile_gate():
    """check_fn for every lilos_* tool — profile reachability only (the
    harness wired this serve's env). Per-session gating lives in the
    pre_tool_call veto + handler, not here: check_fn verdicts are cached
    into per-profile tool defs, so a session-keyed verdict would only leak
    whichever session built first to the rest."""
    return _env() is not None


# ----------------------------------------------------------------- actions

def _call(tool_name, env, session_id, args):
    """POST /tools/<name> — forwards the stored session id as the caller."""
    resp = _request("POST", env[0], env[1], f"/tools/{tool_name}",
                    session=session_id, payload=args or {})
    if isinstance(resp, dict) and resp.get("error"):
        err = resp["error"]
        msg = err.get("message") if isinstance(err, dict) else str(err)
        return f"LilOS tool {TOOL_PREFIX}{tool_name} failed: {msg}"
    return json.dumps(resp.get("result", resp))


def _make_handler(tool_name):
    def handler(args, session_id="", task_id="", **_kw):
        env = _env()
        if env is None:
            return f"{TOOL_PREFIX}{tool_name} is unavailable: LilOS gateway env is not set."
        sid = session_id or task_id
        if not _source_is_lilos(sid):
            return f"{TOOL_PREFIX}{tool_name} only runs inside a LilOS session."
        try:
            return _call(tool_name, env, sid, args)
        except urllib.error.HTTPError as e:
            # The gateway's error body is {"error": {code, message}} — the
            # message carries the zod validation issues for invalid_params,
            # so the model sees WHAT was wrong and can correct the call
            # (a bare "HTTP 400 Bad Request" taught it nothing — #340 live leg).
            detail = ""
            try:
                body = json.loads(e.read() or b"{}")
                detail = (body.get("error") or {}).get("message") or ""
            except Exception:
                detail = ""
            suffix = f" — {detail}" if detail else ""
            return (
                f"{TOOL_PREFIX}{tool_name} failed: HTTP {e.code} {e.reason}"
                f"{suffix}"
            )
        except Exception as e:
            return f"{TOOL_PREFIX}{tool_name} failed: {e}"
    return handler


def _policy_section(session_info):
    """Host policy, fetched per session so each LilOS session gets the
    versioned policy rendered for ITS areas (frozen by core after render)."""
    if session_info.get("platform") != LILOS_SOURCE:
        return ""
    env = _env()
    if env is None:
        return ""
    sid = str(session_info.get("session_id") or "")
    if sid not in _policies:
        try:
            out = _request(
                "POST", env[0], env[1], "/mcp",
                session=sid,
                payload={
                    "jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "hermes-lilos-plugin", "version": "0.1"},
                    },
                },
            )
            _policies[sid] = str((out.get("result") or {}).get("instructions") or "")
        except Exception:
            _policies[sid] = ""
    return _policies[sid]


def _pre_tool_call(tool_name, args=None, session_id="", task_id="", **_kw):
    """Session gate at the call boundary (AC-2, AC-5).

    ``lilos_*`` — refused unless the session's source is ``lilos`` (inert
    outside LilOS); ``browser_*`` — refused inside LilOS sessions, where
    agents drive the session's LilOS browser instead."""
    if _env() is None:
        return None
    name = str(tool_name)
    if name.startswith(TOOL_PREFIX):
        if _source_is_lilos(session_id or task_id):
            return None
        return {
            "action": "block",
            "message": (
                f"{name} only runs inside a LilOS session — this session was "
                "not created by LilOS, so the tool is inert here."
            ),
        }
    if not name.startswith(BROWSER_PREFIX):
        return None
    if not _source_is_lilos(session_id or task_id):
        return None
    return {
        "action": "block",
        "message": (
            "Inside LilOS your own browser tools are off. Use the lilos_"
            "browser_* tools (open/click/type/read/scroll/screenshot) — they "
            "drive the session's LilOS browser so the work is visible in "
            "the LilOS Workbench. web_search and web_extract remain fine for "
            "reading pages; never use them to act on a page."
        ),
    }


# ------------------------------------------------------------------ entry

def register(ctx):
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_system_prompt_section(
        "lilos.host_policy", _policy_section,
        position="after_memory", max_chars=2000,
    )

    env = _env()
    if env is None:
        return

    for tool in _catalog(env):
        name = str(tool.get("name") or "")
        if not name:
            continue
        desc = str(tool.get("description") or f"LilOS {name}")
        ctx.register_tool(
            f"{TOOL_PREFIX}{name}", TOOLSET,
            {
                "name": f"{TOOL_PREFIX}{name}",
                "description": f"{desc} (LilOS sessions only — refused elsewhere.)",
                "parameters": tool.get("inputSchema")
                or {"type": "object", "properties": {}},
            },
            _make_handler(name),
            check_fn=_profile_gate,
            description=desc,
            emoji="🧩",
        )
