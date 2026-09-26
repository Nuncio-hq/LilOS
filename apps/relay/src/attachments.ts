import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MessageAttachment } from "@lilos/contracts/app";
import { newId } from "./store";

/**
 * Attachment blob storage (issue #31). Message rows keep only the
 * `MessageAttachment` ref; the decoded bytes live behind `attachments.get`.
 * The production store writes one JSON file per attachment under the relay
 * home dir (`~/.lilos/attachments/<id>.json`) so bytes survive restarts —
 * a restart must not turn a stored ref into a dangling one while the
 * harness still owes the engine its prompt. Tests use the memory store.
 */
export interface AttachmentStore {
  put(input: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<MessageAttachment>;
  /** The stored blob: display ref + bytes as base64. Null = unknown id. */
  get(
    id: string,
  ): Promise<{ attachment: MessageAttachment; dataBase64: string } | null>;
  /** Best-effort cleanup (e.g. a message write that failed after put). */
  remove(id: string): Promise<void>;
}

export function createMemoryAttachmentStore(): AttachmentStore {
  const blobs = new Map<
    string,
    { attachment: MessageAttachment; dataBase64: string }
  >();
  return {
    async put({ name, mimeType, bytes }) {
      const attachment: MessageAttachment = {
        id: newId("att"),
        name,
        mimeType,
        sizeBytes: bytes.length,
      };
      blobs.set(attachment.id, {
        attachment,
        dataBase64: Buffer.from(bytes).toString("base64"),
      });
      return attachment;
    },
    async get(id) {
      return blobs.get(id) ?? null;
    },
    async remove(id) {
      blobs.delete(id);
    },
  };
}

/** Ids the store itself issued are `att_<uuid>`; anything else never maps to a file. */
const SAFE_ID = /^[\w-]+$/;

export function createFileAttachmentStore(dir: string): AttachmentStore {
  const fileFor = (id: string) => join(dir, `${id}.json`);
  return {
    async put({ name, mimeType, bytes }) {
      const attachment: MessageAttachment = {
        id: newId("att"),
        name,
        mimeType,
        sizeBytes: bytes.length,
      };
      await mkdir(dir, { recursive: true });
      await writeFile(
        fileFor(attachment.id),
        JSON.stringify({
          name,
          mimeType,
          dataBase64: Buffer.from(bytes).toString("base64"),
        }),
      );
      return attachment;
    },
    async get(id) {
      if (!SAFE_ID.test(id)) return null;
      let raw: string;
      try {
        raw = await readFile(fileFor(id), "utf8");
      } catch {
        return null;
      }
      try {
        const row = JSON.parse(raw) as {
          name: string;
          mimeType: string;
          dataBase64: string;
        };
        return {
          attachment: {
            id,
            name: row.name,
            mimeType: row.mimeType,
            sizeBytes: Buffer.from(row.dataBase64, "base64").length,
          },
          dataBase64: row.dataBase64,
        };
      } catch {
        return null;
      }
    },
    async remove(id) {
      if (!SAFE_ID.test(id)) return;
      await rm(fileFor(id), { force: true });
    },
  };
}
