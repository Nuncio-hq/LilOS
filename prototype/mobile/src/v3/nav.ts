import {
  createNavigationContainerRef,
  type NavigationState,
  type NavigatorScreenParams,
  type PartialState,
  StackActions,
} from "@react-navigation/native";

/* Where you can be, and how code outside a screen (a notification, a deep
   link, Pulse) takes you there.

   Each tab owns a native stack: its root screen wears the large title, and
   the detail screens (Agent, Ticket, Project, People) push inside it, so the
   tab bar stays and minimizes as you scroll. A thread has a composer at the
   bottom, so it sits above the tabs, in the root stack, and covers the bar
   (like Messages); so does the Hire sheet. */

export type TabRoutes = {
  Home: NavigatorScreenParams<StackRoutes> | undefined;
  Needs: NavigatorScreenParams<StackRoutes> | undefined;
  Work: NavigatorScreenParams<StackRoutes> | undefined;
  Company: NavigatorScreenParams<StackRoutes> | undefined;
  AskCeo: NavigatorScreenParams<StackRoutes> | undefined;
};
export type TabName = keyof TabRoutes;

/** Inside a tab's stack: its own root, then the details. */
export type StackRoutes = {
  Root: undefined;
  Agent: { agentId: string };
  Ticket: { ticketId: string };
  Project: { projectId: string };
  People: undefined;
};

/** The root stack: the tabs, and what covers them. */
export type CoverRoutes = {
  Tabs: NavigatorScreenParams<TabRoutes>;
  Thread: { threadId: string };
  Hire: undefined;
};

/** Every route a screen may be given, for typing screen props
    (`NativeStackScreenProps<RootRoutes, "Agent">`). */
export type RootRoutes = CoverRoutes & Omit<StackRoutes, "Root">;

export const v3Nav = createNavigationContainerRef<RootRoutes>();

type AnyState = NavigationState | PartialState<NavigationState>;

/** The navigator state the user is looking at: the deepest focused one. */
function focusedState(state: AnyState): AnyState {
  let s = state;
  for (;;) {
    const route = s.routes[s.index ?? s.routes.length - 1];
    if (!route?.state) return s;
    s = route.state;
  }
}

/** The stack of one tab, if that tab has been opened yet. */
function tabStack(tab: TabName): AnyState | undefined {
  const root = v3Nav.getRootState();
  const tabs = root?.routes.find((r) => r.name === "Tabs")?.state;
  return tabs?.routes.find((r) => r.name === tab)?.state;
}

/** Back to the tabs with none of the covering screens left over. */
export function uncover() {
  const root = v3Nav.getRootState();
  if (root && root.index > 0)
    v3Nav.dispatch({ ...StackActions.popToTop(), target: root.key });
}

/** Push a detail screen on the tab you are in. A tab that has not been
    opened yet gets the screen above its root (`initial: false`). */
function pushDetail(name: keyof Omit<StackRoutes, "Root">, params?: object) {
  const root = v3Nav.getRootState();
  if (!v3Nav.isReady() || !root) return;
  const here = focusedState(root);
  if ("key" in here && here.key && here.routeNames?.includes(name)) {
    v3Nav.dispatch({ ...StackActions.push(name, params), target: here.key });
    return;
  }
  // On a covering screen (a thread) or before any stack exists: go to the
  // tab last used, or Home.
  const tabs = root.routes.find((r) => r.name === "Tabs");
  const tab =
    (tabs?.state?.routes[tabs.state.index ?? 0]?.name as TabName | undefined) ??
    "Home";
  uncover();
  v3Nav.navigate("Tabs", {
    screen: tab,
    params: { screen: name, params, initial: false },
  } as never);
}

export function openThread(threadId: string) {
  if (v3Nav.isReady())
    v3Nav.dispatch(StackActions.push("Thread", { threadId }));
}
export function openAgent(agentId: string) {
  pushDetail("Agent", { agentId });
}
export function openTicket(ticketId: string) {
  pushDetail("Ticket", { ticketId });
}
export function openProject(projectId: string) {
  pushDetail("Project", { projectId });
}
export function openPeople() {
  pushDetail("People");
}
export function openHire() {
  if (v3Nav.isReady()) v3Nav.navigate("Hire");
}

/** Switch tab from anywhere, dropping covering screens and anything pushed on
    that tab, so it shows its own root. */
export function openTab(tab: TabName) {
  if (!v3Nav.isReady()) return;
  uncover();
  v3Nav.navigate("Tabs", { screen: tab } as never);
  const stack = tabStack(tab);
  if (stack && "key" in stack && stack.key && (stack.index ?? 0) > 0)
    v3Nav.dispatch({ ...StackActions.popToTop(), target: stack.key });
}

/** Run `fn` once the navigation tree exists (a link or notification that
    launched the app arrives before the first screen is mounted, and a
    switch from the v2 prototype remounts the whole tree). */
export function whenNavReady(fn: () => void, tries = 40) {
  if (v3Nav.isReady()) fn();
  else if (tries > 0) setTimeout(() => whenNavReady(fn, tries - 1), 150);
}
