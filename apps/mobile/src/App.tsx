import "../global.css";

import { exchangePairingGrant } from "@lilos/client-runtime";
import {
  AppText,
  ConnectedScreen,
  ConnectingScreen,
  type ConnectingState,
  DemoBadge,
  MacSheet,
  ManualCodeScreen,
  PairIntroScreen,
  parsePairingUrl,
  Row,
  ScanScreen,
  Section,
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
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, useColorScheme, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import logo from "../assets/logo.png";
import { directoryCache } from "./cache";
import { $demo, DEMO_MAC, enterDemo, exitDemo } from "./demo/lifecycle";
import { openAsks } from "./home-model";
import {
  $blockedUpdate,
  $latencyMs,
  $link,
  $linkError,
  $welcome,
  currentSupervisor,
  startLink,
  stopLink,
} from "./link";
import { blockedLine, connectingOutcome, plainLinkReason } from "./mapping";
import { NetSpyBadge } from "./netspy-badge";
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
import { initPush, unregisterPush } from "./push";
import { PushSettingsSection } from "./push-settings";
import { nav, type Props, type Routes, type TabRoutes } from "./routes";
import { BrowseMac } from "./screens/browse-mac";
import { Dm, FolderPicker, ModelPicker } from "./screens/dm";
import { Activity, Home, NeedsYouSlot, useHomeWire } from "./screens/home";
import {
  Background,
  Plan,
  Subagent,
  Subagents,
  Thread,
  ThreadInfo,
  WbDiff,
} from "./screens/thread";
import { ago } from "./time";
import { formatVersionLabel } from "./version-label";
import { startVisibilityReporting } from "./visibility";

/* apps/mobile — the real app (#154): the prototype's onboarding screens from
   @lilos/ui-native wired to the actual relay. Pairing runs the #153 grant →
   credential exchange; after that a single ConnectionSupervisor owns the
   socket for the app's whole life (cache-first render, afterSeq replay,
   [3,4,8,16]s backoff, probe-or-replace on foreground). */

const Stack = createNativeStackNavigator<Routes>();
const Tab = createNativeBottomTabNavigator<TabRoutes>();

// ── Onboarding ──────────────────────────────────────────────────────────────

/* After `exitDemo` the nav tree remounts on Welcome; this flag makes the
   "Connect your Mac" row continue straight into pairing (#168 AC-4). */
let pendingPairNav = false;

function Welcome({ navigation }: Props<"Welcome">) {
  const notice = useStore($pairNotice);
  useEffect(() => {
    if (!pendingPairNav) return;
    pendingPairNav = false;
    navigation.navigate("Pair");
  }, [navigation]);
  return (
    <WelcomeScreen
      logo={logo}
      notice={notice}
      onStart={() => navigation.navigate("Pair")}
      onDemo={() => void enterDemo()}
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
  const [retryAfter, setRetryAfter] = useState<number | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    navigation.setOptions({ gestureEnabled: state !== "connecting" });
  }, [navigation, state]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the exchange on Try again.
  useEffect(() => {
    const ac = new AbortController();
    /* #593 AC-3: the exchange gets 15s before the Mac is declared
       unreachable; the screen's Cancel aborts the same fetch. The flag
       keeps a timeout firing the "unreachable" state while a user's
       Cancel still exits silently. */
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, 15_000);
    void (async () => {
      try {
        const result = await exchangePairingGrant(
          `http://${offer.host}`,
          {
            code: offer.code,
            name: Device.deviceName ?? "iPhone",
          },
          { signal: ac.signal },
        );
        /* A real grant that resolves after the timeout still counts —
           swallowing it leaves the spinner up forever with the grant
           spent (a retry lands on 'used'). Only a user Cancel/unmount
           exits quietly. */
        if (ac.signal.aborted && !timedOut) return;
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
        if (ac.signal.aborted && !timedOut) return;
        navigation.replace("Connected");
      } catch (error) {
        /* Cancel/unmount leaves the screen quietly; the timeout lands on
           "unreachable" like any other dial failure. */
        if (ac.signal.aborted && !timedOut) return;
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        const outcome = connectingOutcome(error);
        setRetryAfter(outcome.retryAfterSeconds);
        setState(outcome.state);
      }
    })();
    return () => {
      clearTimeout(timeout);
      ac.abort();
    };
  }, [attempt, offer, navigation]);

  return (
    <ConnectingScreen
      state={state}
      macName={offer.name ?? fallbackName(offer.host)}
      host={offer.host}
      retryAfterSeconds={retryAfter}
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
  const link = useStore($link);
  const demo = useStore($demo);
  return (
    <SettingsScreen
      title="Settings"
      app={{
        name: "LilOS",
        // Native bundle values so the shipped TestFlight build number shows.
        versionLabel: formatVersionLabel(
          Constants.nativeAppVersion ??
            Constants.expoConfig?.version ??
            "0.1.0",
          Constants.nativeBuildVersion ??
            Constants.expoConfig?.ios?.buildNumber,
        ),
      }}
      mac={
        demo
          ? { name: DEMO_MAC.name, host: DEMO_MAC.host, routeLabel: "demo" }
          : mac && {
              name: mac.name,
              host: mac.host,
              routeLabel: ROUTE_LABEL[mac.route],
              link,
            }
      }
      /* The row's status dot follows the live link; a tap opens the Mac
         sheet where Forget now lives (#247). In demo there is no real Mac —
         the sheet (and its Forget, which deletes the real Keychain) stays
         unreachable. */
      onOpenMac={demo ? undefined : () => nav.navigate("Mac")}
      onForget={demo ? () => {} : confirmForget}
    >
      {demo ? (
        <Section title="Demo">
          <Row
            onPress={() => {
              pendingPairNav = true;
              exitDemo();
            }}
          >
            <AppText weight="medium">Connect your Mac</AppText>
          </Row>
          <Row onPress={() => exitDemo()}>
            <AppText tone="destructive" weight="medium">
              Exit demo
            </AppText>
          </Row>
        </Section>
      ) : (
        /* #161: the four push kinds + iOS-permission state (AC-6). */
        <PushSettingsSection />
      )}
    </SettingsScreen>
  );
}

function Tabs() {
  const tint = useThemeColor("primary");
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
          /* #247: no header — Home starts at the top under the status bar;
             the Mac lives in Settings and the offline banner opens its
             sheet. */
          headerShown: false,
          tabBarLabel: "Home",
          tabBarIcon: ({ focused }) => ({
            type: "sfSymbol",
            name: focused ? "house.fill" : "house",
          }),
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

function Mac({ navigation }: Props<"Mac">) {
  const mac = useStore($connections)[0];
  const link = useStore($link);
  const lastError = useStore($linkError);
  const blockedUpdate = useStore($blockedUpdate);
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
          /* #597 AC-1: the tile's whole label — a plain reason while
             offline, the seen-age otherwise. */
          lastSeen:
            link === "offline" && lastError
              ? plainLinkReason(lastError)
              : `${link === "online" ? "seen" : "last seen"} ${ago(mac.lastSeenAt)}`,
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
      blocked={
        link === "blocked"
          ? {
              body: blockedLine(blockedUpdate),
              /* The update action: when this iPhone is the stale side the
                 sheet's primary button takes Oscar to TestFlight, where
                 LilOS ships. A Mac-side stale stays a Try again — the
                 update happens on the Mac itself. */
              action:
                blockedUpdate === "phone"
                  ? {
                      label: "Open TestFlight",
                      onPress: () =>
                        void Linking.openURL("https://testflight.apple.com"),
                    }
                  : undefined,
            }
          : undefined
      }
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
          /* #161: best-effort push.unregister on the live socket before it
             dies; the relay's revoke path is the backstop either way. A
             half-dead socket would stall the request's 15s timeout — race
             it so Forget never appears to hang. */
          void Promise.race([
            unregisterPush(),
            new Promise((resolve) => setTimeout(resolve, 1500)),
          ]).finally(() => {
            stopLink();
            void forgetMacs(() => directoryCache.clear());
          });
        },
      },
    ],
  );
}

// ── App shell ───────────────────────────────────────────────────────────────

/* lilos://pair?host=…#code=… from the iOS Camera app jumps straight to
   Connecting while onboarding — same validation as an in-app scan. A link
   that lands during the demo exits it first (#168 AC-4: pairing a real Mac
   wins over the demo). */
function useDeepLinks(phase: string) {
  const url = Linking.useLinkingURL();
  useEffect(() => {
    if (!url) return;
    const offer = parsePairingUrl(url);
    if (!offer || !nav.isReady()) return;
    /* Exiting flips the phase, which refires this effect on the fresh
       onboarding nav tree. */
    if ($demo.get()) return exitDemo();
    if (phase === "onboarding") nav.navigate("Connecting", { offer });
  }, [url, phase]);
}

/* screenLayout functions are invoked inside the navigator's own render —
   they can't call hooks. Gating on $demo has to happen in a mounted child
   component, never in the layout body itself. */
function DemoBadgeIfDemo({ variant }: { variant?: "top" | "sheet" }) {
  const demo = useStore($demo);
  return demo ? <DemoBadge variant={variant} /> : null;
}

/* #168 AC-4: the root Demo pill sits in an overlay above the navigator,
   but iOS form sheets present a new window on top of it — so sheet screens
   mount the badge inside their own screenLayout (which replaces the
   navigator's, so the dev net chip gets re-mounted here too). */
function DemoSheetChrome({ children }: { children: ReactNode }) {
  return (
    <View className="flex-1">
      {children}
      <DemoBadgeIfDemo variant="sheet" />
      {__DEV__ && <NetSpyBadge />}
    </View>
  );
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

/* A conversation's nav bar: transparent over a real blur material, so the
   chat scrolls on under the title and the bar itself stays legible. The
   scroll edge effect alone left scrolled rows crisp behind the two-line
   thread title (#373) — blurEffect paints the whole bar; the docs warn
   against stacking it with an explicit top edge effect, so the top falls
   back to automatic while the bottom keeps the soft fade over the
   floating composer. */
const CHAT_HEADER: NativeStackNavigationOptions = {
  headerTransparent: true,
  headerBlurEffect: "systemMaterial",
  scrollEdgeEffects: { bottom: "soft" },
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
  const demo = useStore($demo);
  const theme = useNavTheme();
  const scheme = useColorScheme();
  const [booted, setBooted] = useState(false);
  useDeepLinks(phase);

  /* Boot order matters for AC-2: Keychain pair → cache hydrate → link start,
     THEN phase "app" unblocks Home — its first paint already shows the
     cached directory. */
  useEffect(() => {
    /* #161: push + thread-visibility wiring is inert until a link exists —
       they only act when $link goes online. */
    initPush();
    startVisibilityReporting();
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
        <View className="flex-1">
          <Stack.Navigator
            key={phase}
            screenOptions={{
              headerShadowVisible: false,
              headerBackButtonDisplayMode: "minimal",
            }}
            /* #168 AC-6 evidence: the dev-only net counter floats on every
             screen — one mount covers stacks, tabs and form sheets alike.
             The Demo pill lives in the root overlay instead so it can sit
             in the top safe-area band above native headers. */
            screenLayout={({ children }) => (
              <View className="flex-1">
                {children}
                {__DEV__ && <NetSpyBadge />}
              </View>
            )}
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
                <Stack.Screen name="Dm" component={Dm} options={CHAT_HEADER} />
                <Stack.Screen
                  name="Thread"
                  component={Thread}
                  options={CHAT_HEADER}
                />
                {/* iOS form sheets present above the root overlay, so the
                    Demo pill mounts inside each of them here (the net chip
                    too — a group's screenLayout replaces the navigator's). */}
                <Stack.Group screenLayout={DemoSheetChrome}>
                  <Stack.Screen
                    name="Mac"
                    component={Mac}
                    options={MAC_SHEET}
                  />
                  <Stack.Screen
                    name="ThreadInfo"
                    component={ThreadInfo}
                    options={SHEET}
                  />
                  <Stack.Screen name="Plan" component={Plan} options={SHEET} />
                  <Stack.Screen
                    name="Subagent"
                    component={Subagent}
                    options={SHEET}
                  />
                  <Stack.Screen
                    name="Subagents"
                    component={Subagents}
                    options={SHEET}
                  />
                  <Stack.Screen
                    name="Background"
                    component={Background}
                    options={SHEET}
                  />
                  <Stack.Screen
                    name="WbDiff"
                    component={WbDiff}
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
                </Stack.Group>
              </>
            )}
          </Stack.Navigator>
          {/* #168 AC-4: Demo pill in the top safe-area band, above every
             screen and native header (form sheets mount their own copy —
             see DemoSheetChrome). */}
          {demo && <DemoBadge />}
        </View>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
