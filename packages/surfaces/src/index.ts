export * from "./backend.js";
export * from "./client.js";
export * from "./config.js";
export * from "./dispatch.js";
export * from "./drivers.js";
export * from "./gateway.js";
export * from "./hub.js";
export * from "./previews.js";
export * from "./scope.js";
export * from "./sentinels.js";
// Node-only entries live at subpaths so this index stays importable from
// browser bundles (prototype imports `openViewer` for the live tabs):
//   `@lilos/surfaces/cli` — the `lilos` CLI main
//   `@lilos/surfaces/mcp` — the MCP stdio server
