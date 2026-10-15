import { z } from "zod";

/**
 * Every type that crosses a boundary (web <-> relay, relay <-> harness,
 * harness <-> engine) is a Zod schema defined here and only here.
 * D-#3 structure: deps run one way — `apps/*` import `packages/*`, never
 * back — and engine packages depend only on this package. Not: vendor
 * engine types in app code. (The engine seam itself is D-#6.) More rules:
 * docs/index.html#map.
 */

/**
 * First real contract: a channel message envelope. The relay is the source of
 * truth for messages; this is the shape it speaks.
 */
export const ChannelMessage = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1),
  authorId: z.string().min(1),
  text: z.string(),
  /** Server-assigned monotonic sequence number per channel. */
  seq: z.int().min(1),
  /** Unix epoch milliseconds. */
  createdAt: z.int().min(0),
});

export type ChannelMessage = z.infer<typeof ChannelMessage>;

export * from "./engine/index.js";
export * from "./host/index.js";
