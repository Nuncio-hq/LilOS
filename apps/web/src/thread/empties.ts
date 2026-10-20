import type {
  ChannelMessagesState,
  SessionFeedState,
} from "@lilos/client-runtime";
import type { AppMessage, Ask } from "@lilos/contracts/app";
import { atom } from "nanostores";

export const EMPTY_MESSAGES = atom<ChannelMessagesState>({
  channelId: "",
  synced: true,
  lastSeq: 0,
  messages: [],
});

export const EMPTY_FEED = atom<SessionFeedState>({
  sessionId: "",
  synced: false,
  latestSeq: 0,
  coverageSeq: 0,
  events: [],
  openRequests: [],
});

/* #427: shared empties for the fold's per-conv slices — a missing row must
   keep one stable reference or every render would look like new input. */
export const NO_MSGS: AppMessage[] = [];
export const NO_ASKS: Ask[] = [];
