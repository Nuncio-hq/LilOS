import { z } from "zod";

/**
 * Every type that crosses a boundary (web <-> relay, relay <-> harness,
 * harness <-> engine) is a Zod schema defined here and only here.
 * See AGENTS.md "Stack & Structure".
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
