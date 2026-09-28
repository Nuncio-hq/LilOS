/* Issue #112 mapping/send layer: composer data-URL files -> wire attachments,
   stored message refs -> chips/thumbnails, and a failed send -> one plain
   line for the toast (AC-4). */
import { RelayError } from "@lilos/client-runtime";
import type { AppMessage } from "@lilos/contracts/app";
import { describe, expect, test } from "vitest";
import { describeSendError } from "../src/lib/actions";
import {
  attachmentUrls,
  toAttachedFiles,
  toAttachmentInputs,
} from "../src/lib/attachments";
import { conversationReplies, toFeed } from "../src/lib/mapping";

const msg = (over: Partial<AppMessage>): AppMessage => ({
  id: "m1",
  channelId: "ch1",
  conversationId: "c1",
  authorId: "user",
  authorKind: "user",
  text: "",
  seq: 1,
  createdAt: 0,
  rewound: false,
  ...over,
});

const conv = {
  id: "c1",
  channelId: "ch1",
  rootMessageId: "m1",
  engineRef: null,
  state: "idle" as const,
  title: "",
  titleSource: "user" as const,
  archived: false,
  deliveredSeq: 0,
  createdAt: 0,
};

const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";

describe("toAttachmentInputs", () => {
  test("converts composer data URLs to base64 wire inputs", () => {
    expect(
      toAttachmentInputs([
        { name: "shot.png", mediaType: "image/png", url: PNG_URL },
      ]),
    ).toEqual([
      { name: "shot.png", mimeType: "image/png", dataBase64: "iVBORw0KGgo=" },
    ]);
  });

  test("no files or only non-data urls -> undefined (field stays absent)", () => {
    expect(toAttachmentInputs(undefined)).toBeUndefined();
    expect(toAttachmentInputs([])).toBeUndefined();
    expect(
      toAttachmentInputs([
        { name: "x.png", mediaType: "image/png", url: "blob:https://x/1" },
      ]),
    ).toBeUndefined();
  });

  test("mime falls back to the data url's when the file lacks one", () => {
    const inputs = toAttachmentInputs([
      { name: "a", mediaType: "", url: PNG_URL },
    ]);
    expect(inputs?.[0]?.mimeType).toBe("image/png");
  });
});

describe("toAttachedFiles", () => {
  test("refs carry name+mime immediately; url fills once bytes resolve", () => {
    const refs = [
      { id: "a1", name: "shot.png", mimeType: "image/png", sizeBytes: 9 },
      { id: "a2", name: "other.png", mimeType: "image/png", sizeBytes: 9 },
    ];
    attachmentUrls.set({ a2: PNG_URL });
    expect(toAttachedFiles(refs)).toEqual([
      { name: "shot.png", mediaType: "image/png", url: undefined },
      { name: "other.png", mediaType: "image/png", url: PNG_URL },
    ]);
    attachmentUrls.set({});
  });

  test("no refs -> undefined so AttachmentChips stays unmounted", () => {
    expect(toAttachedFiles(undefined)).toBeUndefined();
    expect(toAttachedFiles([])).toBeUndefined();
  });
});

describe("mapping carries attachments", () => {
  const attached = msg({
    attachments: [
      { id: "a1", name: "shot.png", mimeType: "image/png", sizeBytes: 9 },
    ],
  });

  test("conversationReplies keeps the refs as chips", () => {
    const [r] = conversationReplies([attached], "c1");
    expect(r.attachments?.[0]?.name).toBe("shot.png");
  });

  test("toFeed puts the root message's chips on the session row", () => {
    const m = toFeed(attached, conv, []);
    expect(m.kind === "msg" && m.attachments?.[0]?.name).toBe("shot.png");
  });
});

describe("describeSendError (AC-4)", () => {
  test("relay attachment_too_large reads plain", () => {
    expect(
      describeSendError(
        new RelayError(
          'attachment "huge.png" is too big',
          "attachment_too_large",
        ),
      ),
    ).toContain("too large");
  });

  test("invalid_params names the image-only rule only for attachments", () => {
    // Attachment validation failures carry issues on the `attachments` path.
    expect(
      describeSendError(
        new RelayError("invalid params", "invalid_params", {
          issues: [{ path: ["attachments", 0, "mimeType"] }],
        }),
      ),
    ).toContain("images");
    // Any other bad params get the generic line, not a misleading one.
    expect(
      describeSendError(
        new RelayError("invalid params", "invalid_params", {
          issues: [{ path: ["channelId"] }],
        }),
      ),
    ).toBe("Couldn't send that. Try again.");
    expect(
      describeSendError(new RelayError("bad params", "invalid_params")),
    ).toBe("Couldn't send that. Try again.");
  });

  test("unreachable relay and unknown errors get generic lines", () => {
    expect(describeSendError(new RelayError("x", "not_connected"))).toContain(
      "relay",
    );
    expect(describeSendError(new Error("boom"))).toBe(
      "Couldn't send that. Try again.",
    );
  });
});
