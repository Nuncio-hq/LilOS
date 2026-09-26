// Spike #24 — MCP stdio shim. Exposes the harness HTTP API as MCP tools so any
// agent framework that speaks MCP can drive the owned browser + terminal.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = process.env.HARNESS_URL || 'http://localhost:7240';

async function api(path, body) {
  const r = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { content: [{ type: 'text', text: JSON.stringify(j) }] };
}

const server = new McpServer({ name: 'lilos-harness', version: '0.1.0' });

server.registerTool('browser_open', {
  description: 'Open a URL in the Workbench-owned browser (shared with the human viewer)',
  inputSchema: { url: z.string() },
}, ({ url }) => api('/api/browser.open', { url }));

server.registerTool('browser_click', {
  description: 'Click in the owned browser. Provide a CSS selector, or page x/y coordinates.',
  inputSchema: { selector: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
}, (a) => api('/api/browser.click', a));

server.registerTool('browser_type', {
  description: 'Type text into the owned browser. Optionally focus a CSS selector first.',
  inputSchema: { text: z.string(), selector: z.string().optional() },
}, (a) => api('/api/browser.type', a));

server.registerTool('browser_read', {
  description: 'Read the owned browser page: url, title, visible text',
  inputSchema: {},
}, () => api('/api/browser.read'));

server.registerTool('browser_scroll', {
  description: 'Scroll the owned browser page vertically',
  inputSchema: { dy: z.number().optional() },
}, (a) => api('/api/browser.scroll', a));

server.registerTool('browser_eval', {
  description: 'Evaluate a JS expression in the owned browser page (page scope)',
  inputSchema: { expr: z.string() },
}, (a) => api('/api/browser.eval', a));

server.registerTool('terminal_run', {
  description: 'Run a shell command in the Workbench-owned terminal and wait for it to finish (returns output + exit code). For long-running servers use terminal_write instead.',
  inputSchema: { command: z.string(), timeout_ms: z.number().optional() },
}, (a) => api('/api/terminal.run', { command: a.command, timeout_ms: a.timeout_ms }));

server.registerTool('terminal_write', {
  description: 'Write raw input to the owned terminal (does not wait for output)',
  inputSchema: { data: z.string() },
}, (a) => api('/api/terminal.write', a));

server.registerTool('terminal_read', {
  description: 'Read recent terminal scrollback from the owned terminal',
  inputSchema: { lines: z.number().optional() },
}, (a) => api('/api/terminal.read', a));

server.registerTool('previews_list', {
  description: 'List preview URLs detected from terminal output (PREVIEW: markers and localhost URLs)',
  inputSchema: {},
}, () => api('/api/previews.list'));

await server.connect(new StdioServerTransport());
