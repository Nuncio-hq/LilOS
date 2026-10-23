import type { NavigatorScreenParams } from "@react-navigation/native";
import {
  createNavigationContainerRef,
  StackActions,
} from "@react-navigation/native";

/* Where you can be, and how code outside a screen (a notification, a deep
   link, Pulse) takes you there. */

export type TabRoutes = {
  Home: undefined;
  Needs: undefined;
  Work: undefined;
  Company: undefined;
  AskCeo: undefined;
};

export type RootRoutes = {
  Tabs: NavigatorScreenParams<TabRoutes>;
  Thread: { threadId: string };
  Agent: { agentId: string };
  Ticket: { ticketId: string };
  Hire: undefined;
};

export const v3Nav = createNavigationContainerRef<RootRoutes>();

/** Back to the tabs with none of the pushed screens left over. */
function toTabs() {
  const root = v3Nav.getRootState();
  if (root && root.index > 0)
    v3Nav.dispatch({ ...StackActions.popToTop(), target: root.key });
}

export function openThread(threadId: string) {
  if (v3Nav.isReady()) v3Nav.navigate("Thread", { threadId });
}
export function openAgent(agentId: string) {
  if (v3Nav.isReady()) v3Nav.navigate("Agent", { agentId });
}
export function openTicket(ticketId: string) {
  if (v3Nav.isReady()) v3Nav.navigate("Ticket", { ticketId });
}
export function openHire() {
  if (v3Nav.isReady()) v3Nav.navigate("Hire");
}
/** Switch tab from anywhere, dropping pushed screens first. */
export function openTab(screen: keyof TabRoutes) {
  if (!v3Nav.isReady()) return;
  toTabs();
  v3Nav.navigate("Tabs", { screen });
}
