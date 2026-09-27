import "../global.css";

import {
  buildPairingUrl,
  Choice,
  ConnectedScreen,
  ConnectingScreen,
  type ConnectingState,
  HomeScreen,
  Icon,
  type MacLink,
  ManualCodeScreen,
  PairIntroScreen,
  type PairingOffer,
  parsePairingUrl,
  ScanScreen,
  Section,
  SettingsScreen,
  useThemeColor,
  WelcomeScreen,
} from "@lilos/ui-native";
import { useStore } from "@nanostores/react";
import {
  createNavigationContainerRef,
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  type Theme,
  useIsFocused,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from "@react-navigation/native-stack";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, useColorScheme, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import logo from "../assets/logo.png";
import {
  $preview,
  $reconnectTick,
  applyPreviewQuery,
  DEMO_OFFER,
  LINK_OUTCOMES,
  type LinkOutcome,
  PAIR_OUTCOMES,
  type PairOutcome,
  pairWithMac,
  reachMac,
  SCAN_OVERRIDES,
  type ScanOverride,
} from "./fake-mac";
import {
  $connections,
  $phase,
  fallbackName,
  forgetMacs,
  hydrateConnections,
  ROUTE_LABEL,
  routeFor,
  savePairedMac,
  touchMac,
} from "./paired-macs";

/* Mobile prototype wiring — the twin of prototype/src/App.tsx: screens come
   from @lilos/ui-native (props in, callbacks out); this file owns navigation,
   the fake Mac, the camera and storage. Onboarding follows the user's steps:
   Welcome → Pair → Scan | Enter code → Connecting → Connected → Home. */

type Routes = {
  Welcome: undefined;
  Pair: undefined;
  Scan: undefined;
  Manual: undefined;
  Connecting: { offer: PairingOffer };
  Connected: undefined;
  Home: undefined;
  Settings: undefined;
};
type Props<T extends keyof Routes> = NativeStackScreenProps<Routes, T>;

const Stack = createNativeStackNavigator<Routes>();
const nav = createNavigationContainerRef<Routes>();

// ── Step 1–2 ────────────────────────────────────────────────────────────────

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

// ── Step 3: scan (camera + permission live here, not in ui-native) ─────────

function Scan({ navigation }: Props<"Scan">) {
  const [permission, requestPermission] = useCameraPermissions();
  const override = useStore($preview).scan;
  const [wrongQr, setWrongQr] = useState(false);
  const locked = useRef(false);
  const focused = useIsFocused();

  useEffect(() => {
    if (
      override === "live" &&
      permission &&
      !permission.granted &&
      permission.canAskAgain
    )
      void requestPermission();
  }, [override, permission, requestPermission]);

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

  // Back from Connecting (Cancel): scanning resumes.
  useEffect(
    () => navigation.addListener("focus", () => (locked.current = false)),
    [navigation],
  );

  useEffect(() => {
    if (!wrongQr) return;
    const t = setTimeout(() => setWrongQr(false), 3000);
    return () => clearTimeout(t);
  }, [wrongQr]);

  const denied =
    override === "denied" ||
    (override === "live" &&
      !!permission &&
      !permission.granted &&
      !permission.canAskAgain);
  const simulated = __DEV__ && !Device.isDevice;

  return (
    <>
      {focused && !denied && <StatusBar style="light" />}
      <ScanScreen
        cameraDenied={denied}
        wrongCode={wrongQr || override === "invalid"}
        camera={
          override === "live" && permission?.granted ? (
            <CameraView
              style={{ position: "absolute", inset: 0 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => onData(data)}
            />
          ) : undefined
        }
        onTapViewfinder={
          simulated ? () => onData(buildPairingUrl(DEMO_OFFER)) : undefined
        }
        onManual={() => navigation.replace("Manual")}
        onOpenSettings={() => void Linking.openSettings()}
      />
    </>
  );
}

function Manual({ navigation }: Props<"Manual">) {
  // Push, so Cancel on Connecting comes back to the filled-in form.
  return (
    <ManualCodeScreen
      onSubmit={(offer) => navigation.navigate("Connecting", { offer })}
    />
  );
}

// ── Step 4–5 ────────────────────────────────────────────────────────────────

function Connecting({ navigation, route }: Props<"Connecting">) {
  const { offer } = route.params;
  const [state, setState] = useState<ConnectingState>("connecting");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    navigation.setOptions({ gestureEnabled: state !== "connecting" });
  }, [navigation, state]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the pairing on Try again.
  useEffect(() => {
    const ac = new AbortController();
    pairWithMac(offer, ac.signal)
      .then(async (r) => {
        if (!r.ok) {
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Error,
          );
          setState(r.reason);
          return;
        }
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        );
        const now = Date.now();
        await savePairedMac({
          id: offer.host,
          name: offer.name ?? r.name,
          host: offer.host,
          route: routeFor(offer.host),
          pairedAt: now,
          lastSeenAt: now,
        });
        navigation.replace("Connected");
      })
      .catch(() => {});
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
      onContinue={() => $phase.set("app")}
    />
  );
}

// ── Step 6: every launch after pairing ──────────────────────────────────────

function Home({ navigation }: Props<"Home">) {
  const mac = useStore($connections)[0];
  const tick = useStore($reconnectTick);
  const [link, setLink] = useState<MacLink>("reconnecting");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          accessibilityLabel="Settings"
          hitSlop={12}
          onPress={() => navigation.navigate("Settings")}
        >
          <Icon name="gearshape" size={22} />
        </Pressable>
      ),
    });
  }, [navigation]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt`/`tick` re-run the reconnect.
  useEffect(() => {
    if (!mac) return;
    const ac = new AbortController();
    setLink("reconnecting");
    reachMac(ac.signal)
      .then((ok) => {
        setLink(ok ? "online" : "offline");
        if (ok) void touchMac(mac.id);
      })
      .catch(() => {});
    return () => ac.abort();
  }, [mac?.id, attempt, tick]);

  // Offline: keep trying quietly every 15 s while the screen is open.
  useEffect(() => {
    if (link !== "offline") return;
    const t = setInterval(() => setAttempt((a) => a + 1), 15_000);
    return () => clearInterval(t);
  }, [link]);

  if (!mac) return null;
  return (
    <HomeScreen
      macName={mac.name}
      link={link}
      routeLabel={ROUTE_LABEL[mac.route]}
      lastConnected={ago(mac.lastSeenAt)}
      onRetry={() => setAttempt((a) => a + 1)}
    />
  );
}

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function Settings() {
  const mac = useStore($connections)[0];
  const preview = useStore($preview);
  const forget = () =>
    Alert.alert(
      "Forget this Mac?",
      "You'll need to scan a new code from the Mac to connect again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: () => void forgetMacs(),
        },
      ],
    );

  return (
    <SettingsScreen
      mac={
        mac && {
          name: mac.name,
          host: mac.host,
          routeLabel: ROUTE_LABEL[mac.route],
        }
      }
      onForget={forget}
    >
      {/* Prototype switcher — the mobile twin of the web Preview menu. */}
      <Section title="Prototype · pairing">
        {PAIR_OUTCOMES.map((o) => (
          <Choice
            key={o.id}
            label={o.label}
            on={preview.pair === o.id}
            onPress={() => $preview.setKey("pair", o.id as PairOutcome)}
          />
        ))}
      </Section>
      <Section title="Prototype · scanner">
        {SCAN_OVERRIDES.map((o) => (
          <Choice
            key={o.id}
            label={o.label}
            on={preview.scan === o.id}
            onPress={() => $preview.setKey("scan", o.id as ScanOverride)}
          />
        ))}
      </Section>
      <Section title="Prototype · reconnect">
        {LINK_OUTCOMES.map((o) => (
          <Choice
            key={o.id}
            label={o.label}
            on={preview.link === o.id}
            onPress={() => {
              $preview.setKey("link", o.id as LinkOutcome);
              $reconnectTick.set($reconnectTick.get() + 1);
            }}
          />
        ))}
      </Section>
    </SettingsScreen>
  );
}

// ── App shell ───────────────────────────────────────────────────────────────

/* lilos://preview?... jumps to a prototype state. lilos://pair?... is a
   pairing QR opened from the iOS Camera app: while onboarding it goes straight
   to Connecting, validated like an in-app scan. */
function useDeepLinks(phase: string) {
  const url = Linking.useLinkingURL();
  useEffect(() => {
    if (!url) return;
    const preview = /^lilos:\/\/preview\/?\?(.*)$/i.exec(url);
    if (preview) {
      const { reset } = applyPreviewQuery(preview[1] ?? "");
      if (reset) void forgetMacs();
      return;
    }
    const offer = parsePairingUrl(url);
    if (offer && phase === "onboarding" && nav.isReady())
      nav.navigate("Connecting", { offer });
  }, [url, phase]);
}

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
      primary: text,
    },
  };
}

export default function App() {
  const phase = useStore($phase);
  const theme = useNavTheme();
  const scheme = useColorScheme();
  useDeepLinks(phase);

  useEffect(() => {
    void hydrateConnections();
  }, []);

  if (phase === "loading") return <View className="flex-1 bg-background" />;

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
                name="Home"
                component={Home}
                options={{ title: "LilOS", headerLargeTitleEnabled: true }}
              />
              <Stack.Screen
                name="Settings"
                component={Settings}
                options={{ title: "Settings" }}
              />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
