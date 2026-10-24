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
import { SafeAreaProvider } from "react-native-safe-area-context";
import { HireContainer } from "./company/hire-sheet";
import { PulseAccessory } from "./home/pulse-accessory";
import { type CoverRoutes, type TabRoutes, v3Nav } from "./nav";
import { useNotifications } from "./notify-bridge";
import {
  AskStack,
  CompanyStack,
  HomeStack,
  NeedsStack,
  WorkStack,
} from "./stacks";
import { $data } from "./store";
import { useV3NavTheme } from "./theme";
import { ThreadContainer } from "./thread/thread-screen";

const Stack = createNativeStackNavigator<CoverRoutes>();
const Tab = createNativeBottomTabNavigator<TabRoutes>();

/* Four tabs and the search-role tab, each a native stack (stacks.tsx) with its
   own large title. The Company pulse is the bar's bottom accessory (like
   Music's mini player) and opens the CEO; when the bar minimizes on scroll it
   becomes the short inline form. */
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
        component={HomeStack}
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
        component={NeedsStack}
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
        component={WorkStack}
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
        component={CompanyStack}
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
        component={AskStack}
        options={{
          tabBarSystemItem: "search",
          tabBarLabel: "Ask the CEO",
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
      <Stack.Screen
        name="Thread"
        component={ThreadContainer}
        getId={({ params }) => params.threadId}
      />
      <Stack.Screen name="Hire" component={HireContainer} options={SHEET} />
    </Stack.Navigator>
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
      </View>
    </SafeAreaProvider>
  );
}
