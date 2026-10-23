import { useThemeColor } from "@lilos/ui-native";
import { useStore } from "@nanostores/react";
import { createNativeBottomTabNavigator } from "@react-navigation/bottom-tabs/unstable";
import { NavigationContainer } from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useColorScheme, View } from "react-native";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { AgentContainer } from "./company/agent-screen";
import { CompanyContainer } from "./company/company-screen";
import { HireContainer } from "./company/hire-sheet";
import { useV3DeepLinks } from "./deep-links";
import { HomeContainer } from "./home/home-screen";
import { PulseAccessory } from "./home/pulse-accessory";
import { type RootRoutes, type TabRoutes, v3Nav } from "./nav";
import { NeedsContainer } from "./needs/needs-screen";
import { useNotifications } from "./notify-bridge";
import { AskCeoContainer } from "./search/search-screen";
import { $data } from "./store";
import { useV3NavTheme } from "./theme";
import { ThreadContainer } from "./thread/thread-screen";
import { TicketContainer } from "./work/ticket-screen";
import { WorkContainer } from "./work/work-screen";

const Stack = createNativeStackNavigator<RootRoutes>();
const Tab = createNativeBottomTabNavigator<TabRoutes>();

/* Four tabs and the search-role tab. Each tab draws its own serif title in
   its content, so the bar carries buttons only; the Company pulse is the
   bar's bottom accessory (like Music's mini player) and opens the CEO. */
function Tabs() {
  const open = useStore($data).asks.length;
  const ink = useThemeColor("ink");
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ink,
        tabBarMinimizeBehavior: "onScrollDown",
        bottomAccessory: ({ placement }) => (
          <PulseAccessory placement={placement} />
        ),
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeContainer}
        options={{
          tabBarLabel: "Home",
          tabBarIcon: ({ focused }) => ({
            type: "sfSymbol",
            name: focused ? "house.fill" : "house",
          }),
        }}
      />
      <Tab.Screen
        name="Needs"
        component={NeedsContainer}
        options={{
          tabBarLabel: "Needs you",
          tabBarBadge: open || undefined,
          tabBarIcon: ({ focused }) => ({
            type: "sfSymbol",
            name: focused ? "tray.full.fill" : "tray.full",
          }),
        }}
      />
      <Tab.Screen
        name="Work"
        component={WorkContainer}
        options={{
          tabBarLabel: "Work",
          tabBarIcon: ({ focused }) => ({
            type: "sfSymbol",
            name: focused ? "square.stack.fill" : "square.stack",
          }),
        }}
      />
      <Tab.Screen
        name="Company"
        component={CompanyContainer}
        options={{
          tabBarLabel: "Company",
          tabBarIcon: ({ focused }) => ({
            type: "sfSymbol",
            name: focused ? "person.2.fill" : "person.2",
          }),
        }}
      />
      <Tab.Screen
        name="AskCeo"
        component={AskCeoContainer}
        options={{
          tabBarSystemItem: "search",
          tabBarLabel: "Ask the CEO",
          title: "Ask the CEO",
          headerShown: true,
          // The search field is the CEO's door; the pulse would crowd it.
          bottomAccessory: undefined,
        }}
      />
    </Tab.Navigator>
  );
}

/* A native iOS form sheet; iOS 26 draws it as Liquid Glass. */
const SHEET: NativeStackNavigationOptions = {
  headerShown: false,
  presentation: "formSheet",
  sheetAllowedDetents: [0.62, 1],
  sheetGrabberVisible: true,
  sheetCornerRadius: 28,
  contentStyle: { backgroundColor: "transparent" },
};

function Routes() {
  useV3DeepLinks();
  useNotifications();
  return (
    <Stack.Navigator
      screenOptions={{
        headerShadowVisible: false,
        headerBackButtonDisplayMode: "minimal",
        title: "",
      }}
    >
      <Stack.Screen
        name="Tabs"
        component={Tabs}
        options={{ headerShown: false }}
      />
      <Stack.Screen name="Thread" component={ThreadContainer} />
      <Stack.Screen name="Agent" component={AgentContainer} />
      <Stack.Screen name="Ticket" component={TicketContainer} />
      <Stack.Screen name="Hire" component={HireContainer} options={SHEET} />
    </Stack.Navigator>
  );
}

/* Content scrolls under the status bar (no header on the tabs); a paper
   strip keeps the clock and battery readable instead of printing over rows. */
function StatusBarScrim() {
  const { top } = useSafeAreaInsets();
  return (
    <View
      pointerEvents="none"
      className="absolute inset-x-0 top-0 bg-paper"
      style={{ height: top }}
    />
  );
}

export function V3App() {
  const theme = useV3NavTheme();
  const scheme = useColorScheme();
  return (
    <SafeAreaProvider>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <View className="flex-1 bg-paper">
        <NavigationContainer ref={v3Nav} theme={theme}>
          <Routes />
        </NavigationContainer>
        <StatusBarScrim />
      </View>
    </SafeAreaProvider>
  );
}
