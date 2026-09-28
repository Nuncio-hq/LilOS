import "../global.css";

import {
  exchangePairingGrant,
  PairingExchangeFailed,
} from "@lilos/client-runtime";
import type { AppChannel, Employee } from "@lilos/contracts/app";
import {
  ConnectedScreen,
  ConnectingScreen,
  type ConnectingState,
  EmployeesHomeScreen,
  MacSheet,
  ManualCodeScreen,
  PairIntroScreen,
  type PairingOffer,
  parsePairingUrl,
  ScanScreen,
  SettingsScreen,
  useThemeColor,
  WelcomeScreen,
} from "@lilos/ui-native";
import { useStore } from "@nanostores/react";
import { createNativeBottomTabNavigator } from "@react-navigation/bottom-tabs/unstable";
import {
  createNavigationContainerRef,
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  type NavigatorScreenParams,
  type Theme,
  useIsFocused,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
  type NativeStackScreenProps,
} from "@react-navigation/native-stack";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { atom } from "nanostores";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, useColorScheme, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import logo from "../assets/logo.png";
import { directoryCache } from "./cache";
import {
  $client,
  $latencyMs,
  $link,
  $linkError,
  $welcome,
  currentSupervisor,
  startLink,
  stopLink,
} from "./link";
import { toEmployeeRow, toHomeChannels } from "./mapping";
import {
  $connections,
  $phase,
  fallbackName,
  forgetMacs,
  hydrateConnections,
  ROUTE_LABEL,
  routeFor,
  savePairedMac,
} from "./paired-macs";

/* apps/mobile — the real app (#154): the prototype's onboarding screens from
   @lilos/ui-native wired to the actual relay. Pairing runs the #153 grant →
   credential exchange; after that a single ConnectionSupervisor owns the
   socket for the app's whole life (cache-first render, afterSeq replay,
   [3,4,8,16]s backoff, probe-or-replace on foreground). */

type Routes = {
  Welcome: undefined;
  Pair: undefined;
  Scan: undefined;
  Manual: undefined;
  Connecting: { offer: PairingOffer };
  Connected: undefined;
  Tabs: NavigatorScreenParams<TabRoutes>;
  Mac: undefined;
};
type TabRoutes = {
  Home: undefined;
  Settings: undefined;
};
type Props<T extends keyof Routes> = NativeStackScreenProps<Routes, T>;

const Stack = createNativeStackNavigator<Routes>();
const Tab = createNativeBottomTabNavigator<TabRoutes>();
const nav = createNavigationContainerRef<Routes>();

// ── Onboarding ──────────────────────────────────────────────────────────────

function Welcome({ navigation }: Props<"Welcome">) {
  return (
    <WelcomeScreen logo={logo} onStart={() => navigation.navigate("Pair")} />
  );
}

function Pair({ navigation }: Props<"Pair">) {
  return (
    <PairIntroScreen
      onScan={() => navigation.navigate("Scan")}
      onManual={() => navigation.navigate("Manual")}
    />
  );
}

function Scan({ navigation }: Props<"Scan">) {
  const [permission, requestPermission] = useCameraPermissions();
  const [wrongQr, setWrongQr] = useState(false);
  const locked = useRef(false);
  const focused = useIsFocused();

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain)
      void requestPermission();
  }, [permission, requestPermission]);

  const onData = useCallback(
    (data: string) => {
      if (locked.current) return;
      const offer = parsePairingUrl(data);
      if (!offer) {
        setWrongQr(true);
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Warning,
        );
        return;
      }
      locked.current = true;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      navigation.navigate("Connecting", { offer });
    },
    [navigation],
  );

  useEffect(
    () => navigation.addListener("focus", () => (locked.current = false)),
    [navigation],
  );

  useEffect(() => {
    if (!wrongQr) return;
    const t = setTimeout(() => setWrongQr(false), 3000);
    return () => clearTimeout(t);
  }, [wrongQr]);

  const denied = !!permission && !permission.granted && !permission.canAskAgain;

  return (
    <>
      {focused && !denied && <StatusBar style="light" />}
      <ScanScreen
        cameraDenied={denied}
        wrongCode={wrongQr}
        camera={
          permission?.granted ? (
            <CameraView
              style={{ position: "absolute", inset: 0 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => onData(data)}
            />
          ) : undefined
        }
        onManual={() => navigation.replace("Manual")}
        onOpenSettings={() => void Linking.openSettings()}
      />
    </>
  );
}

function Manual({ navigation }: Props<"Manual">) {
  return (
    <ManualCodeScreen
      onSubmit={(offer) => navigation.navigate("Connecting", { offer })}
    />
  );
}

/* The only place the grant is spent: POST {host}/pair/exchange → the phone's
   own device credential, straight into the Keychain list. */
function Connecting({ navigation, route }: Props<"Connecting">) {
  const { offer } = route.params;
  const [state, setState] = useState<ConnectingState>("connecting");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    navigation.setOptions({ gestureEnabled: state !== "connecting" });
  }, [navigation, state]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the exchange on Try again.
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const result = await exchangePairingGrant(`http://${offer.host}`, {
          code: offer.code,
          name: Device.deviceName ?? "iPhone",
        });
        if (ac.signal.aborted) return;
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        );
        const now = Date.now();
        await savePairedMac({
          id: result.deviceId,
          name: offer.name ?? fallbackName(offer.host),
          host: offer.host,
          route: routeFor(offer.host),
          pairedAt: now,
          lastSeenAt: now,
          deviceId: result.deviceId,
          credential: result.credential,
        });
        navigation.replace("Connected");
      } catch (error) {
        if (ac.signal.aborted) return;
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setState(
          error instanceof PairingExchangeFailed &&
            (error.reason === "expired" || error.reason === "used")
            ? "expired"
            : "unreachable",
        );
      }
    })();
    return () => ac.abort();
  }, [attempt, offer, navigation]);

  return (
    <ConnectingScreen
      state={state}
      macName={offer.name ?? fallbackName(offer.host)}
      host={offer.host}
      onCancel={() => navigation.goBack()}
      onRetry={() => {
        setState("connecting");
        setAttempt((a) => a + 1);
      }}
      onRescan={() => navigation.popTo("Scan")}
      onManual={() => navigation.popTo("Manual")}
    />
  );
}

function Connected() {
  const mac = useStore($connections)[0];
  return (
    <ConnectedScreen
      macName={mac?.name ?? "your Mac"}
      routeLabel={mac ? ROUTE_LABEL[mac.route] : ""}
      onContinue={() => {
        const current = $connections.get()[0];
        if (current) startLink(current);
        $phase.set("app");
      }}
    />
  );
}

// ── The app after pairing ───────────────────────────────────────────────────

const $noEmployees = atom<Employee[]>([]);
const $noChannels = atom<AppChannel[]>([]);

function soon(what: string) {
  Alert.alert(`${what} come next`, "This release covers the Home list.");
}

function Home() {
  const mac = useStore($connections)[0];
  const client = useStore($client);
  const link = useStore($link);
  const employees = useStore(client?.employees ?? $noEmployees);
  const channels = useStore(client?.channels ?? $noChannels);
  const { company, projects } = toHomeChannels(channels);

  if (!mac) return null;
  return (
    <EmployeesHomeScreen
      workspace="LilOS"
      macName={mac.name}
      link={link}
      employees={employees.map(toEmployeeRow)}
      company={company}
      projects={projects}
      onOpenMac={() => nav.navigate("Mac")}
      onOpenEmployee={() => soon("Direct messages")}
      onOpenChannel={() => soon("Channels")}
    />
  );
}

function Settings() {
  const mac = useStore($connections)[0];
  return (
    <SettingsScreen
      title="Settings"
      mac={
        mac && {
          name: mac.name,
          host: mac.host,
          routeLabel: ROUTE_LABEL[mac.route],
        }
      }
      onForget={confirmForget}
    />
  );
}

function Tabs() {
  const link = useStore($link);
  const tint = useThemeColor("primary");
  const destructive = useThemeColor("destructive");
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: true,
        headerTitle: "",
        headerShadowVisible: false,
        tabBarActiveTintColor: tint,
        tabBarMinimizeBehavior: "onScrollDown",
      }}
    >
      <Tab.Screen
        name="Home"
        component={Home}
        options={{
          title: "LilOS",
          tabBarLabel: "Home",
          tabBarIcon: ({ focused }) => ({
            type: "sfSymbol",
            name: focused ? "house.fill" : "house",
          }),
          unstable_headerRightItems: () => [
            {
              type: "button",
              label: "Mac",
              icon: { type: "sfSymbol", name: "laptopcomputer" },
              tintColor: link === "offline" ? destructive : undefined,
              accessibilityLabel:
                link === "offline" ? "Mac, can't reach it" : "Mac",
              onPress: () => nav.navigate("Mac"),
            },
          ],
        }}
      />
      <Tab.Screen
        name="Settings"
        component={Settings}
        options={{
          title: "Settings",
          tabBarIcon: ({ focused }) => ({
            type: "sfSymbol",
            name: focused ? "gearshape.fill" : "gearshape",
          }),
        }}
      />
    </Tab.Navigator>
  );
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

function Mac({ navigation }: Props<"Mac">) {
  const mac = useStore($connections)[0];
  const link = useStore($link);
  const lastError = useStore($linkError);
  const welcome = useStore($welcome);
  const latency = useStore($latencyMs);
  if (!mac) return null;
  const engineHost = welcome?.engineHost;
  return (
    <MacSheet
      mac={{
        name: mac.name,
        host: mac.host,
        route: ROUTE_LABEL[mac.route],
        link,
        relay: {
          version: welcome?.relayVersion ?? "—",
          latency: latency === undefined ? undefined : `${latency} ms`,
          lastSeen:
            link === "offline" && lastError ? lastError : ago(mac.lastSeenAt),
        },
        engine: {
          name: engineHost?.detail ?? (engineHost?.connected ? "Hermes" : "—"),
          version: engineHost?.connected
            ? (engineHost.state ?? "running")
            : "not running",
        },
        paired: new Date(mac.pairedAt).toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
        }),
      }}
      onRetry={() => currentSupervisor()?.retryNow()}
      onForget={() => {
        navigation.goBack();
        confirmForget();
      }}
      onDone={() => navigation.goBack()}
    />
  );
}

function confirmForget() {
  Alert.alert(
    "Forget this Mac?",
    "You'll need to scan a new code from the Mac to connect again.",
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Forget",
        style: "destructive",
        onPress: () => {
          stopLink();
          void forgetMacs(() => directoryCache.clear());
        },
      },
    ],
  );
}

// ── App shell ───────────────────────────────────────────────────────────────

/* lilos://pair?host=…#code=… from the iOS Camera app jumps straight to
   Connecting while onboarding — same validation as an in-app scan. */
function useDeepLinks(phase: string) {
  const url = Linking.useLinkingURL();
  useEffect(() => {
    if (!url) return;
    const offer = parsePairingUrl(url);
    if (offer && phase === "onboarding" && nav.isReady())
      nav.navigate("Connecting", { offer });
  }, [url, phase]);
}

const MAC_SHEET: NativeStackNavigationOptions = {
  headerShown: false,
  presentation: "modal",
};

function useNavTheme(): Theme {
  const dark = useColorScheme() === "dark";
  const base = dark ? DarkTheme : DefaultTheme;
  const background = useThemeColor("background") ?? base.colors.background;
  const text = useThemeColor("foreground") ?? base.colors.text;
  const border = useThemeColor("border") ?? base.colors.border;
  return {
    ...base,
    colors: {
      ...base.colors,
      background,
      card: background,
      text,
      border,
      primary: useThemeColor("primary") ?? text,
    },
  };
}

export default function App() {
  const phase = useStore($phase);
  const theme = useNavTheme();
  const scheme = useColorScheme();
  const [booted, setBooted] = useState(false);
  useDeepLinks(phase);

  /* Boot order matters for AC-2: Keychain pair → cache hydrate → link start,
     THEN phase "app" unblocks Home — its first paint already shows the
     cached directory. */
  useEffect(() => {
    void (async () => {
      await hydrateConnections();
      const mac = $connections.get()[0];
      if (mac) {
        const cached = await directoryCache.load();
        startLink(mac, cached ?? undefined);
      }
      setBooted(true);
    })();
    return () => stopLink();
  }, []);

  if (phase === "loading" || !booted)
    return <View className="flex-1 bg-background" />;

  return (
    <SafeAreaProvider>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <NavigationContainer ref={nav} theme={theme}>
        <Stack.Navigator
          key={phase}
          screenOptions={{
            headerShadowVisible: false,
            headerBackButtonDisplayMode: "minimal",
          }}
        >
          {phase === "onboarding" ? (
            <>
              <Stack.Screen
                name="Welcome"
                component={Welcome}
                options={{ headerShown: false }}
              />
              <Stack.Screen
                name="Pair"
                component={Pair}
                options={{ title: "" }}
              />
              <Stack.Screen
                name="Scan"
                component={Scan}
                options={{
                  title: "",
                  headerTransparent: true,
                  headerTintColor: "#ffffff",
                }}
              />
              <Stack.Screen
                name="Manual"
                component={Manual}
                options={{ title: "" }}
              />
              <Stack.Screen
                name="Connecting"
                component={Connecting}
                options={{ title: "" }}
              />
              <Stack.Screen
                name="Connected"
                component={Connected}
                options={{
                  title: "",
                  headerBackVisible: false,
                  gestureEnabled: false,
                }}
              />
            </>
          ) : (
            <>
              <Stack.Screen
                name="Tabs"
                component={Tabs}
                options={{ headerShown: false }}
              />
              <Stack.Screen name="Mac" component={Mac} options={MAC_SHEET} />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
