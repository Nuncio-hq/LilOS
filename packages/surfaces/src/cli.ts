import process from "node:process";
import { LILOS_TOOLS } from "@lilos/contracts/harness";
import { toolBackend } from "./client.js";
import { surfacesEnv } from "./config.js";
import { callTool } from "./dispatch.js";
import { serveMcpStdioFromEnv } from "./mcp.js";

const USAGE = `lilos — drive this session's app surfaces (terminal / browser / thread / workbench)

Usage:
  lilos <tool> [json-params]        run one tool, print the JSON result
  lilos <area> <action> [json]      same call, two words: \`lilos thread read\` = \`lilos thread_read\`
  lilos tools                     list the tool names
  lilos mcp                       serve the tools as an MCP stdio server

Env (the harness sets these on every session's MCP server; for a manual CLI
run set them yourself):
  LILOS_SURFACES_URL   surfaces endpoint, e.g. http://127.0.0.1:4578
  LILOS_TOKEN          surfaces auth token
  LILOS_SESSION        session id this call is scoped to

Tools (rendered from the one catalog — \`packages/contracts\` LILOS_TOOLS):
${Object.entries(LILOS_TOOLS)
  .map(([name, t]) => `  ${name.padEnd(22)} ${t.doc}`)
  .join("\n")}

Examples:
  lilos terminal_run '{"command":"ls"}'
  lilos terminal run '{"command":"ls"}'
  lilos thread post '{"text":"done"}'
  lilos browser_open '{"url":"http://localhost:3000"}'
`;

/**
 * `lilos` CLI (AC-1/AC-2): the same ops the MCP server exposes, as
 * subcommands with JSON in / JSON out — tool names resolve from the one
 * catalog, in `<area>_<action>` or `<area> <action>` form. Exit 0 with the
 * result object on stdout; exit 2 with `{error}` on misuse or backend
 * failure.
 */
export async function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const [first, second, ...rest] = argv;
  if (!first || first === "help" || first === "--help" || first === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (first === "tools") {
    process.stdout.write(`${JSON.stringify(Object.keys(LILOS_TOOLS))}\n`);
    return 0;
  }
  if (first === "mcp") {
    await serveMcpStdioFromEnv(env);
    return Number(process.exitCode ?? 0);
  }
  // Canonical `<area>_<action>` names — also accepted split across two words.
  let name = first;
  let jsonArg = second;
  if (!(name in LILOS_TOOLS) && second !== undefined) {
    const joined = `${first}_${second}`;
    if (joined in LILOS_TOOLS) {
      name = joined;
      jsonArg = rest[0];
    }
  }
  if (!(name in LILOS_TOOLS)) {
    process.stderr.write(
      `lilos: unknown tool '${argv.slice(0, 2).join(" ")}'\n\n${USAGE}`,
    );
    return 2;
  }
  let args: unknown = {};
  if (jsonArg !== undefined) {
    try {
      args = JSON.parse(jsonArg);
    } catch {
      process.stderr.write(`lilos: params must be JSON: ${jsonArg}\n`);
      return 2;
    }
  }
  const resolved = surfacesEnv(env);
  if ("error" in resolved) {
    process.stderr.write(`lilos: ${resolved.error}\n`);
    return 2;
  }
  try {
    const result = await callTool(toolBackend(resolved), name, args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(
      `lilos: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 2;
  }
}
