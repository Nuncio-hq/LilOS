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
] as const;
export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];
