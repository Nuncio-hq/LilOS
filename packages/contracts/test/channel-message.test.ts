import { describe, expect, it } from "vitest";
import { ChannelMessage } from "../src/index";

const valid = {
  id: "msg_1",
  channelId: "ch_general",
  authorId: "emp_ada",
  text: "hello from the contract",
  seq: 1,
  createdAt: 1_759_000_000_000,
};

describe("ChannelMessage", () => {
  it("accepts a well-formed message", () => {
    expect(ChannelMessage.parse(valid)).toEqual(valid);
  });

  it("rejects a message without a seq", () => {
    const { seq: _seq, ...noSeq } = valid;
    expect(ChannelMessage.safeParse(noSeq).success).toBe(false);
  });

  it("rejects a non-positive seq", () => {
    expect(ChannelMessage.safeParse({ ...valid, seq: 0 }).success).toBe(false);
  });
});
