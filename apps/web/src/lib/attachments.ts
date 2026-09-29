import type { AttachmentInput, MessageAttachment } from "@lilos/contracts/app";
import type { AttachedFile } from "@lilos/ui/types";
import { atom } from "nanostores";
import { relay } from "./runtime";

/**
 * Attachment bytes live behind `attachments.get` — messages, history pages
 * and replay frames carry only refs (issue #31). This atom caches
 * attachment id -> data URL for the chips/thumbnails; `ensureAttachments`
 * fills it lazily and components re-render off the atom change.
 */
export const attachmentUrls = atom<Record<string, string>>({});

const inflight = new Set<string>();

/** Fetch the bytes behind every ref the cache doesn't have yet. */
export function ensureAttachments(refs: MessageAttachment[]): void {
  for (const r of refs) {
    if (!r.id || attachmentUrls.get()[r.id] || inflight.has(r.id)) continue;
    inflight.add(r.id);
    void relay
      .request<{ attachment: MessageAttachment; dataBase64: string }>(
        "attachments.get",
        { id: r.id },
      )
      .then((res) => {
        attachmentUrls.set({
          ...attachmentUrls.get(),
          [r.id]: `data:${res.attachment.mimeType};base64,${res.dataBase64}`,
        });
      })
      .catch(() => {
        // A ref whose blob is gone keeps the chip, just without a thumbnail.
      })
      .finally(() => inflight.delete(r.id));
  }
}

/**
 * Message refs -> AttachedFile chips: name + mime now, `url` filled once the
 * blob resolved (components reading `attachmentUrls` re-render then).
 */
export function toAttachedFiles(
  refs: MessageAttachment[] | undefined,
): AttachedFile[] | undefined {
  if (!refs?.length) return undefined;
  const urls = attachmentUrls.get();
  return refs.map((r) => ({
    name: r.name || "attachment",
    mediaType: r.mimeType,
    url: urls[r.id],
  }));
}

/**
 * Refs -> AttachedFile[] with the bytes inlined as data URLs (issue #134
 * AC-4): rewound message images re-enter the composer as real chips, so a
 * resend ships them untouched. Refs whose blob can't be fetched are dropped.
 */
export async function hydrateAttachments(
  refs: MessageAttachment[] | undefined,
): Promise<AttachedFile[]> {
  const out = await Promise.all(
    (refs ?? []).map(
      (r): Promise<AttachedFile | null> =>
        relay
          .request<{ attachment: MessageAttachment; dataBase64: string }>(
            "attachments.get",
            { id: r.id },
          )
          .then((res) => ({
            name: r.name || "attachment",
            mediaType: r.mimeType,
            url: `data:${res.attachment.mimeType};base64,${res.dataBase64}`,
          }))
          .catch(() => null),
    ),
  );
  return out.flatMap((f) => (f === null ? [] : [f]));
}

/**
 * Composer files (data URLs out of PromptInput) -> wire attachments. Anything
 * whose `url` isn't a base64 data URL can't cross the wire and is dropped.
 */
export function toAttachmentInputs(
  files: AttachedFile[] | undefined,
): AttachmentInput[] | undefined {
  const out: AttachmentInput[] = [];
  for (const f of files ?? []) {
    const url = f.url ?? "";
    if (!url.startsWith("data:")) continue;
    const comma = url.indexOf(",");
    const head = url.slice(5, comma);
    const data = comma >= 0 ? url.slice(comma + 1) : "";
    if (!data || !head.endsWith(";base64")) continue;
    out.push({
      name: f.name,
      mimeType: f.mediaType || head.slice(0, -";base64".length),
      dataBase64: data,
    });
  }
  return out.length ? out : undefined;
}
