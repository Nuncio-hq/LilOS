// Spike #24 — scripted agent: a real MCP stdio client driving the harness
// through the same tools a live engine would use. Paced for the recording.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(`\x1b[36m[agent]\x1b[0m ${s}`);
const step = async (name, args, wait = 1200) => {
  say(`tool call → ${name} ${JSON.stringify(args)}`);
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content?.[0]?.text;
  say(`  ← ${String(txt).slice(0, 220)}`);
  await sleep(wait);
  return r;
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp-server.mjs'],
  env: { ...process.env, HARNESS_URL: 'http://localhost:7240' },
});
const client = new Client({ name: 'demo-agent', version: '0.0.1' });
await client.connect(transport);
say('connected to lilos-harness MCP server');

// Agent task: "open the demo app, click the button twice, type a note,
// then in the terminal create+serve a static site and open its preview."
await step('browser_open', { url: 'http://localhost:7240/demo' }, 2000);
await step('browser_click', { selector: '#bump' });
await step('browser_click', { selector: '#bump' });
await step('browser_type', { selector: '#echo-in', text: 'typed by the agent via MCP' }, 2000);
await step('browser_read', {}, 1000);

await step('terminal_run', { command: "mkdir -p /tmp/site && echo '<h1 style=\"font:40px sans-serif;color:#2f81f7\">agent-built preview site</h1>' > /tmp/site/index.html && echo built" }, 1500);
await step('terminal_write', { data: 'cd /tmp/site && python3 -m http.server 8911 &\n' }, 2500);
await step('previews_list', {}, 1500);
await step('browser_open', { url: 'http://localhost:8911' }, 2500);
await step('terminal_run', { command: 'echo "agent done"; uname -s' }, 800);

say('demo sequence finished');
await client.close();
process.exit(0);
