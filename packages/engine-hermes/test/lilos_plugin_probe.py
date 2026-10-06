"""Probe for the #411 AC-4 test: run the lilos plugin's register() against a
stub plugin context and report wall-clock time + registered tool names as
one JSON line on stdout.

Usage: python3 lilos_plugin_probe.py <path to the plugin's __init__.py>
"""
import importlib.util
import json
import sys
import time


class _Ctx:
    """The slice of Hermes' plugin ctx the lilos plugin touches."""

    def __init__(self):
        self.tools = []

    def register_hook(self, name, fn):
        pass

    def register_system_prompt_section(self, *args, **kwargs):
        pass

    def register_tool(self, name, toolset, spec, handler, **kwargs):
        self.tools.append(name)


plugin = sys.argv[1]
spec = importlib.util.spec_from_file_location("lilos_plugin", plugin)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

ctx = _Ctx()
t0 = time.monotonic()
mod.register(ctx)
report = {"seconds": time.monotonic() - t0, "tools": ctx.tools}

# #549 AC-2: with a LilOS-source session (env stamp is the acp path's mark),
# every hermes browser_* tool must be refused truthfully — lilos_browser_*
# named where one exists, "no alternative" where none does.
if "--gate" in sys.argv:
    for tool in ("browser_exec", "browser_vault_fill", "lilos_context"):
        verdict = mod._pre_tool_call(tool, {}, "sid-probe")
        report[tool] = None if verdict is None else verdict.get("message", "")

print(json.dumps(report))
