import type { RelayClient } from "./client";

/**
 * The client surface `apps/mobile` binds to (#168): the atoms and methods
 * the screens and stores actually read. `RelayClient` satisfies it
 * structurally; the offline demo's `DemoClient` implements the same
 * surface, so screens never branch on where their data comes from — they
 * get a different data source.
 *
 * The members are picked off the `RelayClient` class so the two can't
 * drift: a member the app starts reading must exist here, which makes the
 * demo fail to compile until it implements it too.
 */
export type AppClient = Pick<
  RelayClient,
  | "state"
  | "employees"
  | "channels"
  | "conversations"
  | "conversationSummaries"
  | "profile"
  | "asks"
  | "devices"
  | "directoryReady"
  | "fatal"
  | "rewinds"
  | "status"
  | "lastSocketError"
  | "connect"
  | "close"
  | "ping"
  | "request"
  | "channelMessages"
  | "sessionFeed"
  | "unsubscribeChannel"
  | "onEvent"
  | "hydrate"
  | "snapshot"
  | "listModels"
>;
