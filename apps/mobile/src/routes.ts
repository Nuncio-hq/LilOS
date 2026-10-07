import type { PairingOffer } from "@lilos/ui-native";
import {
  createNavigationContainerRef,
  type NavigatorScreenParams,
} from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

/* Route table + the container ref, shared by App.tsx and the screens so a
   screen can navigate without importing App (that would be a cycle). */

export type Routes = {
  Welcome: undefined;
  Pair: undefined;
  Scan: undefined;
  Manual: undefined;
  Connecting: { offer: PairingOffer };
  Connected: undefined;
  Tabs: NavigatorScreenParams<TabRoutes>;
  Mac: undefined;
  /** An employee's DM; `{ employeeId }` selects whose. */
  Dm: { employeeId: string };
  /* The DM slice's stack routes (#156); #157 adds ThreadInfo + the
     thread-scoped model pick (conversationId present = thread scope).
     `employeeId` is the employee the push/ask resolved this thread to —
     the gone card's "Back to <employee>" uses it once the thread itself
     is unknown to the directory (#596). */
  Thread: { conversationId: string; employeeId?: string };
  ThreadInfo: { conversationId: string };
  /* #182: the thread's plan sheet — every version, files per step, risks. */
  Plan: { conversationId: string };
  /* #181: one subagent of a turn in that thread; the session's background
     jobs sheet (pill above the composer opens it). #319: every helper of
     that thread — the turn's "N subagents · Open" line opens it. */
  Subagent: { conversationId: string; id: string };
  Subagents: { conversationId: string };
  Background: { conversationId: string };
  /* #340: a `workbench_open` card's diffs view (the phone's Changes tab);
     `path` narrows the rows to the file the card named. */
  WbDiff: { conversationId: string; path?: string };
  FolderPicker: { employeeId: string };
  /* "Other folder on the Mac…" browser (#238), pushed over FolderPicker. */
  BrowseMac: { employeeId: string };
  ModelPicker: { employeeId: string; conversationId?: string };
};

/* The DM stack as the dm/thread screens see it. */
export type DmRoutes = Pick<
  Routes,
  | "Dm"
  | "Thread"
  | "ThreadInfo"
  | "Plan"
  | "Subagent"
  | "Subagents"
  | "Background"
  | "WbDiff"
  | "FolderPicker"
  | "BrowseMac"
  | "ModelPicker"
>;

export type TabRoutes = {
  Home: undefined;
  Activity: undefined;
  Settings: undefined;
};

export type Props<T extends keyof Routes> = NativeStackScreenProps<Routes, T>;

export const nav = createNavigationContainerRef<Routes>();
