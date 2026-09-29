/* View models for the LilOS Browser (issue #214): Oscar's everyday browser,
   shared with agents. Pure data in; the app owns the real pages (a native
   WebContentsView in LilOS.app, fake pages in the prototype). */

/** A thread (one engine session) that owns a group of browser tabs. */
export type BrowserThread = { id: string; title: string; employeeId: string };

/** A tab that belongs to a thread's group (absent on Oscar's own tabs). The
    thread's agent only ever uses its own group, so parallel threads never
    share a tab; every tab shares the one LilOS profile (sign-ins). */
export type BrowserTabAgent = {
  employeeId: string;
  threadId: string;
  /** "agent" = the agent drives; "you" = Oscar took control (D-#56 rule). */
  control: "agent" | "you";
  /** What the agent is doing right now, e.g. `Clicking "Sign in"`. */
  action?: string;
};

export type BrowserTab = {
  id: string;
  title: string;
  url: string;
  loading?: boolean;
  agent?: BrowserTabAgent;
};

export type BrowserHistoryItem = {
  url: string;
  title: string;
  /** Display time, e.g. "10:42" or "Yesterday". */
  when: string;
};

export type BrowserBookmark = { url: string; title: string };

export type BrowserDownload = {
  id: string;
  name: string;
  size: string;
  /** 0..1 while downloading; absent once finished. */
  progress?: number;
  when?: string;
};

/** A saved sign-in for the current site (the password never leaves the store). */
export type SavedLogin = { id: string; username: string };

/** panel = docked beside the chat · window = popped out ·
    thread = embedded in a thread's Workbench, showing only that thread's tabs. */
export type BrowserMode = "panel" | "window" | "thread";

/** Find-in-page state (controlled by the app, which knows the page text). */
export type BrowserFind = { query: string; index: number };

export type BrowserLibraryTab = "history" | "bookmarks" | "downloads";
