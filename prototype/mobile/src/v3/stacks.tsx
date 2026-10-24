import { agentOf } from "@lilos/ui/v3-data";
import { useThemeColor } from "@lilos/ui-native";
import { useStore } from "@nanostores/react";
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import type { ComponentType } from "react";
import { AgentContainer } from "./company/agent-screen";
import { CompanyContainer } from "./company/company-screen";
import { HIRE_BUTTON } from "./company/hire-button";
import { PeopleContainer } from "./company/people-screen";
import { HomeContainer } from "./home/home-screen";
import type { StackRoutes } from "./nav";
import { NeedsContainer } from "./needs/needs-screen";
import { AskCeoContainer } from "./search/search-screen";
import { $data } from "./store";
import { ProjectContainer } from "./work/project-screen";
import { TicketContainer } from "./work/ticket-screen";
import { WorkContainer } from "./work/work-screen";

/* One native stack per tab. The root screen has the native large title in the
   v3 serif, which collapses to an inline title as the content scrolls; the
   detail screens push above it and keep the tab bar, which minimizes with the
   same scroll. The content's first scroll view must be the one UIKit watches:
   `Page` is that (contentInsetAdjustmentBehavior automatic). */

const Stack = createNativeStackNavigator<StackRoutes>();

const SERIF = { fontFamily: "Charter" } as const;

const DETAIL: NativeStackNavigationOptions = {
  headerShadowVisible: false,
  headerBackButtonDisplayMode: "minimal",
  headerTitleStyle: SERIF,
  title: "",
};

const LARGE: NativeStackNavigationOptions = {
  headerLargeTitle: true,
  headerLargeTitleShadowVisible: false,
  headerLargeTitleStyle: SERIF,
};

function TabStack({
  title,
  root,
  rootOptions,
}: {
  title: string;
  root: ComponentType;
  rootOptions?: NativeStackNavigationOptions;
}) {
  const ink = useThemeColor("ink");
  return (
    <Stack.Navigator screenOptions={{ ...DETAIL, headerTintColor: ink }}>
      <Stack.Screen
        name="Root"
        component={root}
        options={{ ...LARGE, title, ...rootOptions }}
      />
      {/* The options of a pushed screen are set here, from its params, so the
          push transition starts with the right title (setOptions from the
          screen itself lands a frame late). */}
      <Stack.Screen
        name="Agent"
        component={AgentContainer}
        getId={({ params }) => params.agentId}
        options={({ route }) => ({
          ...LARGE,
          title: agentOf($data.get(), route.params.agentId)?.name ?? "",
        })}
      />
      <Stack.Screen
        name="Ticket"
        component={TicketContainer}
        getId={({ params }) => params.ticketId}
        options={({ route }) => ({ title: route.params.ticketId })}
      />
      <Stack.Screen
        name="Project"
        component={ProjectContainer}
        getId={({ params }) => params.projectId}
        options={({ route }) => ({
          ...LARGE,
          title:
            $data.get().projects.find((p) => p.id === route.params.projectId)
              ?.name ?? "Project",
        })}
      />
      <Stack.Screen
        name="People"
        component={PeopleContainer}
        getId={() => "people"}
        options={{ ...LARGE, title: "People", ...HIRE_BUTTON }}
      />
    </Stack.Navigator>
  );
}

export function HomeStack() {
  const company = useStore($data).company;
  return <TabStack title={company} root={HomeContainer} />;
}

export function NeedsStack() {
  return <TabStack title="Needs you" root={NeedsContainer} />;
}

export function WorkStack() {
  return <TabStack title="Work" root={WorkContainer} />;
}

export function CompanyStack() {
  return (
    <TabStack
      title="Company"
      root={CompanyContainer}
      rootOptions={HIRE_BUTTON}
    />
  );
}

export function AskStack() {
  return <TabStack title="Ask the CEO" root={AskCeoContainer} />;
}
