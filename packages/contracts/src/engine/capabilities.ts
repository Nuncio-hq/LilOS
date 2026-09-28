import { z } from "zod";

/**
 * A capability descriptor as returned by `describe`. The UI renders affordances
 * from this list and never branches on the engine's identity (`if engine ==
 * ...` is forbidden by the parent feature #5). `methods` lists the wire
 * methods the capability turns on; capability-specific fields go through
 * `detail` so generic clients can still render id/name.
 */
export const Capability = z.object({
  /** Stable id a suite or UI surface keys on, e.g. "steer". */
  id: z.string().min(1),
  /** Human-readable label. */
  name: z.string().min(1),
  description: z.string().optional(),
  /** Wire methods this capability enables (empty = pure protocol surface). */
  methods: z.array(z.string().min(1)).optional(),
  /** Free-form per-capability detail (option lists, limits, ...). */
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type Capability = z.infer<typeof Capability>;

/**
 * Capability ids with a registered conformance suite in
 * `packages/engine-conformance`. Engines MAY declare ids outside this set —
 * clients must treat unknown ids as opaque (render name/description, don't
 * call their methods).
 */
export const KNOWN_CAPABILITIES = [
  "steer",
  "image_prompt",
  "mcp_servers",
  "models",
  "agents",
  "usage",
  "plan",
  "rewind",
  "session_meta",
] as const;
export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];

/**
 * The canonical `steer` descriptor (issue #9): engine-fake returns it verbatim
 * and other engines keep the same id/name/methods, adding engine-specific
 * description/detail where useful. `session.steer` injects text into the
 * running turn: it lands at the next tool boundary as a `turn.steered` event.
 * An accepted steer is never lost — when the turn ends before the next
 * boundary, the text becomes the next turn's input. A `not_running` result
 * means the engine consumed nothing: send `prompt` instead.
 */
export const STEER_CAPABILITY: Capability = {
  id: "steer",
  name: "Session steer",
  description:
    "Text sent mid-turn lands at the next tool boundary of the running turn.",
  methods: ["session.steer"],
};

/**
 * The canonical `image_prompt` descriptor (issue #31): `prompt` accepts
 * image content blocks (`{type:"image", data, mimeType}`) alongside text.
 * Engines not declaring it reject image blocks with invalid-params.
 */
export const IMAGE_PROMPT_CAPABILITY: Capability = {
  id: "image_prompt",
  name: "Image prompts",
  description: "prompt accepts image content blocks (base64 data + mimeType).",
  methods: ["prompt"],
};

/**
 * The canonical `session_meta` descriptor (issue #28): the app's rename /
 * archive writes mirror onto the engine session as title / hidden so the
 * engine's own session lists stay consistent with the app's.
 */
export const SESSION_META_CAPABILITY: Capability = {
  id: "session_meta",
  name: "Session metadata",
  description:
    "Rename/hide the engine's session (title / hidden) so it tracks the app's conversation.",
  methods: ["session.setTitle", "session.setHidden"],
  /** `autoTitle`: the engine writes session titles itself (#137) — it emits
      `session.titled` (derived, then an optional llm upgrade) and carries
      `title` in the `events.since` snapshot. Apps mirror those; engines
      without the flag leave the placeholder title alone. */
  detail: { autoTitle: true },
};

/**
 * The canonical `plan` descriptor (issue #180): the engine streams
 * `plan.updated` snapshots — `kind:"tasks"` for its own working list (ticks
 * live, never asks) and `kind:"plan"` for a proposal gated by a `plan`
 * EngineRequest (`request.respond` outcomes `approve` / `reject` / `change`,
 * the change text in `answer`). `detail.proposals` is true only when the
 * engine can open a `plan` request; engines with a task-list surface only
 * declare it false. Clients render nothing without the capability (D-#19).
 */
export const PLAN_CAPABILITY: Capability = {
  id: "plan",
  name: "Plans & task lists",
  description:
    "Streams plan.updated snapshots; a plan request asks the client to approve, reject or change a proposed plan.",
  methods: ["request.respond"],
  detail: { proposals: true },
};
