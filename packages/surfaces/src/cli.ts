import { LILOS_TOOLS } from "@lilos/contracts/harness";
import { toolBackend } from "./client.js";
import { surfacesEnv } from "./config.js";
import { callTool } from "./dispatch.js";
import { serveMcpStdioFromEnv } from "./mcp.js";

const USAGE = `lilos — drive this session's app surfaces (browser / terminal / conversation)

Usage:
  lilos <tool> [json-params]    run one tool, print the JSON result
  lilos tools                   list the tool names
  lilos mcp                     serve the tools as an MCP stdio server

Env (the harness sets these on every session's MCP server; for a manual CLI
run set them yourself):
  LILOS_SURFACES_URL   surfaces endpoint, e.g. http://127.0.0.1:4578
  LILOS_TOKEN          surfaces auth token
  LILOS_SESSION        session id this call is scoped to

Tools:
${Object.entries(LILOS_TOOLS)
  .map(([name, t]) => `  ${name.padEnd(22)} ${t.doc}`)
  .join("\n")}

Examples:
  lilos terminal_run '{"command":"ls"}'
  lilos browser_open '{"url":"http://localhost:3000"}'
  lilos app_post_message '{"text":"done"}'
`;

/**
 * `lilos` CLI (AC-2): the same ops the MCP server exposes, as subcommands
 * with JSON in / JSON out. Exit 0 with the result object on stdout; exit 2
 * with `{error}` on misuse or backend failure.
 */
export async function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const [name, jsonArg] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (name === "tools") {
    process.stdout.write(`${JSON.stringify(Object.keys(LILOS_TOOLS))}\n`);
    return 0;
  }
  if (name === "mcp") {
    await serveMcpStdioFromEnv(env);
    return Number(process.exitCode ?? 0);
  }
  if (!(name in LILOS_TOOLS)) {
    process.stderr.write(`lilos: unknown tool '${name}'\n\n${USAGE}`);
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
