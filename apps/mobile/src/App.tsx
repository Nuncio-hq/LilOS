import "../global.css";

import {
  exchangePairingGrant,
  PairingExchangeFailed,
} from "@lilos/client-runtime";
import {
  ConnectedScreen,
  ConnectingScreen,
  type ConnectingState,
  MacSheet,
  ManualCodeScreen,
  PairIntroScreen,
  parsePairingUrl,
  ScanScreen,
  SettingsScreen,
  useThemeColor,
  WelcomeScreen,
} from "@lilos/ui-native";
import { useStore } from "@nanostores/react";
import { createNativeBottomTabNavigator } from "@react-navigation/bottom-tabs/unstable";
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  type Theme,
  useIsFocused,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, useColorScheme, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import logo from "../assets/logo.png";
import { directoryCache } from "./cache";
import { openAsks } from "./home-model";
import {
  $latencyMs,
  $link,
  $linkError,
  $welcome,
  currentSupervisor,
  startLink,
  stopLink,
} from "./link";
import {
  $connections,
  $pairNotice,
  $phase,
  fallbackName,
  forgetMacs,
  hydrateConnections,
  ROUTE_LABEL,
  routeFor,
  savePairedMac,
} from "./paired-macs";
import { nav, type Props, type Routes, type TabRoutes } from "./routes";
import { BrowseMac } from "./screens/browse-mac";
import { Dm, FolderPicker, ModelPicker } from "./screens/dm";
import { Activity, Home, NeedsYouSlot, useHomeWire } from "./screens/home";
import { Thread, ThreadInfo } from "./screens/thread";

/* apps/mobile — the real app (#154): the prototype's onboarding screens from
   @lilos/ui-native wired to the actual relay. Pairing runs the #153 grant →
   credential exchange; after that a single ConnectionSupervisor owns the
   socket for the app's whole life (cache-first render, afterSeq replay,
   [3,4,8,16]s backoff, probe-or-replace on foreground). */

const Stack = createNativeStackNavigator<Routes>();
const Tab = createNativeBottomTabNavigator<TabRoutes>();

// ── Onboarding ──────────────────────────────────────────────────────────────

function Welcome({ navigation }: Props<"Welcome">) {
  const notice = useStore($pairNotice);
  return (
    <WelcomeScreen
      logo={logo}
      notice={notice}
      onStart={() => navigation.navigate("Pair")}
    />
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
  const { wire } = useHomeWire();
  const waiting = openAsks(wire.asks).length;
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: true,
        headerTitle: "",
        headerShadowVisible: false,
        tabBarActiveTintColor: tint,
        tabBarMinimizeBehavior: "onScrollDown",
        // The oldest waiting ask, Music-mini-player style — mounted only
        // while any exist (AC-2).
        bottomAccessory: waiting
          ? ({ placement }) => <NeedsYouSlot placement={placement} />
          : undefined,
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
        name="Activity"
        component={Activity}
        options={{
          title: "Needs you",
          tabBarLabel: "Activity",
          // This tab is the full list; the accessory would repeat it.
          bottomAccessory: undefined,
          tabBarBadge: waiting || undefined,
          tabBarIcon: ({ focused }) => ({
            type: "sfSymbol",
            name: focused ? "tray.fill" : "tray",
          }),
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

/* Native iOS form sheet: medium + large detents, grabber, content sized to
   the stack so it can grow. */
const SHEET: NativeStackNavigationOptions = {
  headerShown: false,
  presentation: "formSheet",
  sheetAllowedDetents: [0.62, 1],
  sheetGrabberVisible: true,
  sheetCornerRadius: 28,
  // No painted background: iOS 26 draws the sheet as Liquid Glass.
  contentStyle: { backgroundColor: "transparent" },
};

/* A conversation's nav bar: transparent over a native blur material, so the
   chat scrolls on under the title and stays readable. */
const CHAT_HEADER: NativeStackNavigationOptions = {
  headerTransparent: true,
  scrollEdgeEffects: { top: "soft", bottom: "soft" },
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
              <Stack.Screen name="Dm" component={Dm} options={CHAT_HEADER} />
              <Stack.Screen
                name="Thread"
                component={Thread}
                options={CHAT_HEADER}
              />
              <Stack.Screen
                name="ThreadInfo"
                component={ThreadInfo}
                options={SHEET}
              />
              <Stack.Screen
                name="FolderPicker"
                component={FolderPicker}
                options={SHEET}
              />
              <Stack.Screen
                name="BrowseMac"
                component={BrowseMac}
                options={SHEET}
              />
              <Stack.Screen
                name="ModelPicker"
                component={ModelPicker}
                options={SHEET}
              />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
