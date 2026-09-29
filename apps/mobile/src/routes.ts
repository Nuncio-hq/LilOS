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
     thread-scoped model pick (conversationId present = thread scope). */
  Thread: { conversationId: string };
  ThreadInfo: { conversationId: string };
  FolderPicker: { employeeId: string };
  ModelPicker: { employeeId: string; conversationId?: string };
};

/* The DM stack as the dm/thread screens see it. */
export type DmRoutes = Pick<
  Routes,
  "Dm" | "Thread" | "ThreadInfo" | "FolderPicker" | "ModelPicker"
>;

export type TabRoutes = {
  Home: undefined;
  Activity: undefined;
  Settings: undefined;
};

export type Props<T extends keyof Routes> = NativeStackScreenProps<Routes, T>;

export const nav = createNavigationContainerRef<Routes>();
