import { z } from "zod";

/**
 * Prompt content blocks — the ACP `ContentBlock` shape (text is mandatory for
 * every engine; `image` is the `image_prompt` capability). Audio, resource
 * links and embedded resources are reserved for later capabilities, so they
 * are deliberately absent from this union.
 */
export const TextBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export type TextBlock = z.infer<typeof TextBlock>;

export const ImageBlock = z.object({
  type: z.literal("image"),
  /** Base64-encoded image bytes. */
  data: z.string().min(1),
  mimeType: z.string().min(1),
  uri: z.string().optional(),
});
export type ImageBlock = z.infer<typeof ImageBlock>;

export const ContentBlock = z.discriminatedUnion("type", [
  TextBlock,
  ImageBlock,
]);
export type ContentBlock = z.infer<typeof ContentBlock>;
