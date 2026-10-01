import { LILOS_TOOLS } from "./tools.js";

/**
 * Gateway coverage map (issue #337 AC-4): every app-wire method
 * (`app/wire.ts` `AppMethod`) and every host method (`host/methods.ts`
 * `HOST_METHODS`) is either mapped to a tool the agent can call or listed in
 * `NOT_AGENT_FACING` with a reason. The coverage test iterates both enums and
 * fails `bun run verify` on anything unclassified — the map is exhaustive by
 * construction, never by memory.
 */

/**
 * Tool names the coverage map may point at that are not implemented yet —
 * declared here so the catalog's canonical names are reserved once and the
 * slices that implement them drop the name into LILOS_TOOLS as-is. Empty
 * since #340 landed slice C; slice D (#341) may reserve the approval tools.
 */
export const PLANNED_TOOL_NAMES = [] as const;
export type PlannedToolName = (typeof PLANNED_TOOL_NAMES)[number];

/** Any name a method may map to: implemented now or planned. */
export function knownToolNames(): ReadonlySet<string> {
  return new Set([...Object.keys(LILOS_TOOLS), ...PLANNED_TOOL_NAMES]);
}

/**
 * App/host methods that map to an agent-facing tool. The tool may be planned
 * rather than shipped — the mapping is the contract, the implementation is
 * the slice that lands it.
 */
export const AGENT_METHOD_TOOLS: Record<string, string> = {
  "messages.list": "thread_read",
  "messages.post": "thread_post",
  "messages.search": "thread_search",
  "conversations.list": "thread_list",
  "conversations.summaries": "thread_list",
  "conversations.update": "thread_set_title",
  "conversations.prs": "thread_prs",
  "employees.list": "team_list",
  "system.status": "context",
  "profile.get": "context",
  "folders.detail": "context",
  "workbench.open": "workbench_open",
} as const;

/**
 * Methods that ARE agent-facing but only through an approval — the tool
 * lands with the slice-D approval gate (#341). Named here so the coverage
 * test holds the seat.
 */
export const APPROVAL_GATED_METHODS: Record<string, string> = {
  "conversations.open":
    "start a thread — approval tool lands with the gate (slice D)",
  "employees.create":
    "hire an employee — approval tool lands with the gate (slice D)",
  "employees.update":
    "edit an employee — approval tool lands with the gate (slice D)",
  "agents.list":
    "the agent roster surfaces through `context`; changing it is approval-gated (slice D)",
  "agents.describe":
    "agent profile detail surfaces through `context`; changing it is approval-gated (slice D)",
  "agents.create": "create an engine agent profile — approval-gated (slice D)",
  "agents.update": "update an engine agent profile — approval-gated (slice D)",
  "folders.add": "bind a repo folder — approval-gated (slice D)",
} as const;

/**
 * Everything else: each entry names why the agent never gets a tool for it.
 * Keys must be real AppMethod/HOST_METHODS names — the coverage test checks
 * both directions so a renamed method can't silently drop its reason.
 */
export const NOT_AGENT_FACING: Record<string, string> = {
  /* app wire — transport and harness bookkeeping */
  "session.hello":
    "transport handshake — app↔relay capability negotiation, not agent data",
  "session.ping": "transport keep-alive probe for the connection supervisor",
  "session.events":
    "transport: relay replays the turn stream for device clients",
  "channel.subscribe":
    "transport: channel fan-out subscription for live updates",
  "channel.unsubscribe": "transport: channel fan-out subscription",
  "engine.event": "transport: relay re-publishes one engine event",
  "harness.register": "harness bookkeeping — the engine host registers itself",
  "harness.report": "harness bookkeeping — the host reports session state",
  "messages.setCheckpoint":
    "host bookkeeping — stamps the pre-turn rewind checkpoint",
  /* app wire — the agent raises asks through its engine; answering is the user's */
  "asks.open": "the agent's engine raises asks; the app renders them",
  "asks.respond": "answering an ask is the user's action",
  "asks.list": "the ask inbox is the user's",
  /* app wire — user controls of a session */
  "turns.interrupt": "the user interrupts a running turn",
  "conversations.rewind": "the user rewinds a conversation",
  "conversations.setModel": "the user picks the session's model",
  "models.list": "the model pick list is the user's",
  /* app wire — user and device admin */
  "settings.get": "user settings, not agent scope",
  "settings.set": "user settings, not agent scope",
  "profile.update": "the user edits their own identity",
  "pairing.offer": "phone pairing is the user's opt-in",
  "pairing.disable": "phone pairing is the user's",
  "devices.list": "device admin is the user's",
  "devices.revoke": "device admin is the user's",
  "push.register": "device push registration is the user's",
  "push.unregister": "device push registration is the user's",
  "push.visibility": "device push reporting is the user's",
  "employees.remove": "only Oscar removes an employee",
  /* app wire — covered by `context`, the prompt, or the engine's own tools (D-#179) */
  "channels.list": "channel roster comes through `context`, not a tool",
  "channels.openDm":
    "opening a DM is a company change — the user does it, or an approval tool (slice D)",
  "attachments.get": "media bytes for the app renderer, not the agent",
  "jobs.list": "the engine's own job tools report its background work",
  "jobs.stop": "the engine's own job tools stop its background work",
  "folders.list": "the user's recent folders, not the agent's",
  "folders.browse": "folder picking is the user's",
  "folders.discover": "folder picking is the user's",
  /* host feed — the engine has its own file/git tools in the session folder */
  "host.describe": "host API bookkeeping for the app, not the agent",
  "host.user": "identity prefill for the user",
  "fs.list": "the engine has its own file tools in the session folder",
  "fs.complete": "the engine has its own file tools",
  "fs.tree": "the engine has its own file tools",
  "fs.search": "the engine has its own file tools",
  "fs.read": "the engine has its own file tools",
  "git.isRepo":
    "the engine runs git itself; folder + branch also come through `context`",
  "git.branches": "the engine runs git itself",
  "git.status": "the engine runs git itself",
  "git.diff": "the engine runs git itself",
  "git.worktrees": "the engine runs git itself",
  "git.discoverRepos": "the engine runs git itself",
  "forge.pr":
    "the engine uses `gh` itself; the thread's PRs come through `thread_prs`",
  "forge.prs":
    "the engine uses `gh` itself; the thread's PRs come through `thread_prs`",
  "forge.comment": "the engine uses `gh` itself",
  "forge.merge":
    "only Oscar merges — an approval tool may land with the gate (#341)",
  "os.editors": "the editor list opens for the user on the Mac",
  "os.open":
    "opening apps happens for the user on the Mac; the agent's surface is `workbench_previews`",
} as const;
