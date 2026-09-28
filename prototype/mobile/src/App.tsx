import "../global.css";

import {
  ApprovalsSheet,
  BackgroundSheet,
  buildPairingUrl,
  Choice,
  ConnectedScreen,
  ConnectingScreen,
  type ConnectingState,
  DmHeaderTitle,
  EmployeeDmScreen,
  EmployeesHomeScreen,
  FolderPickerSheet,
  type MacLink,
  MacSheet,
  ManualCodeScreen,
  ModelPickerSheet,
  modelLabel,
  NeedsYouAccessory,
  PairIntroScreen,
  type PairingOffer,
  PlanSheet,
  parsePairingUrl,
  pickLabel,
  ScanScreen,
  Section,
  SettingsScreen,
  SubagentSheet,
  ThreadHeaderTitle,
  ThreadInfoSheet,
  ThreadScreen,
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
  StackActions,
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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Alert, useColorScheme, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import logo from "../assets/logo.png";
import {
  $approvals,
  $employees,
  $projects,
  $threads,
  approve,
  approvePlan,
  deny,
  playOnOpen,
  rejectPlan,
  reply,
  resetTeam,
  startLife,
  startSession,
  stop,
  stopJob,
  turnsOf,
} from "./fake-engine";
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
  $modelPick,
  $threadModel,
  $wsPick,
  COMPANY,
  FOLDERS,
  MODELS,
  PROVIDERS,
} from "./fake-team";
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
  Tabs: NavigatorScreenParams<TabRoutes>;
  Dm: { employeeId: string };
  Thread: { id: string };
  ThreadInfo: { id: string };
  /** A subagent of a turn in that thread (issue #170). */
  Subagent: { thread: string; id: string };
  Background: { thread: string };
  /** The thread's plan, every version (issue #175). */
  Plan: { thread: string };
  Approvals: undefined;
  Mac: undefined;
  FolderPicker: undefined;
  /** No thread = the next DM session's model. */
  ModelPicker: { thread?: string };
};
/* The app's three tabs: the system's glass tab bar (iOS 26), with the
   "needs you" accessory above it while anyone is blocked on you. */
type TabRoutes = {
  Home: undefined;
  Activity: undefined;
  Settings: undefined;
};
type Props<T extends keyof Routes> = NativeStackScreenProps<Routes, T>;

const Stack = createNativeStackNavigator<Routes>();
const Tab = createNativeBottomTabNavigator<TabRoutes>();
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

const $link = atom<MacLink>("reconnecting");
const $attempt = atom(0);

function Home() {
  const mac = useStore($connections)[0];
  const tick = useStore($reconnectTick);
  const employees = useStore($employees);
  const projects = useStore($projects);
  const link = useStore($link);
  const attempt = useStore($attempt);

  // The team starts working the first time Home shows.
  useEffect(() => startLife(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt`/`tick` re-run the reconnect.
  useEffect(() => {
    if (!mac) return;
    const ac = new AbortController();
    $link.set("reconnecting");
    reachMac(ac.signal)
      .then((ok) => {
        $link.set(ok ? "online" : "offline");
        if (ok) void touchMac(mac.id);
      })
      .catch(() => {});
    return () => ac.abort();
  }, [mac?.id, attempt, tick]);

  // Offline: keep trying quietly every 15 s while the screen is open.
  useEffect(() => {
    if (link !== "offline") return;
    const t = setInterval(() => $attempt.set($attempt.get() + 1), 15_000);
    return () => clearInterval(t);
  }, [link]);

  if (!mac) return null;
  return (
    <EmployeesHomeScreen
      workspace="LilOS"
      macName={mac.name}
      link={link}
      employees={employees}
      company={COMPANY}
      projects={projects}
      onOpenMac={() => nav.navigate("Mac")}
      onOpenEmployee={(id) => nav.navigate("Dm", { employeeId: id })}
      onOpenChannel={() => soon("Channels")}
    />
  );
}

function Activity() {
  const approvals = useStore($approvals);
  return (
    <ApprovalsSheet
      approvals={approvals}
      onApprove={(id) => decide(id, true)}
      onDeny={(id) => decide(id, false)}
      onOpen={(id) => openApproval(id)}
    />
  );
}

/* Bar buttons are native UIBarButtonItems, so iOS 26 draws them as one
   shared glass capsule; the tab bar and its accessory are native too. */
function Tabs() {
  const approvals = useStore($approvals);
  const link = useStore($link);
  const tint = useThemeColor("primary");
  const destructive = useThemeColor("destructive");
  return (
    <Tab.Navigator
      screenOptions={{
        // Bar = buttons only; each tab draws its own LargeTitle.
        headerShown: true,
        headerTitle: "",
        headerShadowVisible: false,
        tabBarActiveTintColor: tint,
        tabBarMinimizeBehavior: "onScrollDown",
        bottomAccessory: approvals.length
          ? ({ placement }) => (
              <NeedsYouAccessory
                approvals={approvals}
                placement={placement}
                onApprove={(id) => decide(id, true)}
                onOpen={() => nav.navigate("Tabs", { screen: "Activity" })}
              />
            )
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
            {
              type: "button",
              label: "New session",
              icon: { type: "sfSymbol", name: "square.and.pencil" },
              onPress: () => nav.navigate("Dm", { employeeId: "builder" }),
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
          tabBarBadge: approvals.length || undefined,
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

function decide(approvalId: string, approved: boolean) {
  void Haptics.notificationAsync(
    approved
      ? Haptics.NotificationFeedbackType.Success
      : Haptics.NotificationFeedbackType.Warning,
  );
  if (approved) approve(approvalId);
  else deny(approvalId);
}

function soon(what: string) {
  Alert.alert(`${what} come next`, "This round covers employees and DMs.");
}

function Dm({ navigation, route }: Props<"Dm">) {
  const employee = useStore($employees).find(
    (e) => e.id === route.params.employeeId,
  );
  const threads = useStore($threads);
  const ws = useStore($wsPick);
  const pick = useStore($modelPick);
  const turns = employee ? turnsOf(threads, employee.id) : [];
  const status = statusOf(turns);
  useLayoutEffect(() => {
    if (!employee) return;
    navigation.setOptions({
      headerTitle: () => (
        <DmHeaderTitle
          name={employee.name}
          tone={employee.tone}
          state={employee.state}
          status={status}
          onPress={() => soon("Profiles")}
        />
      ),
      unstable_headerRightItems: () => [
        {
          type: "button",
          label: "More",
          icon: { type: "sfSymbol", name: "ellipsis" },
          onPress: () => soon("Profiles"),
        },
      ],
    });
  }, [navigation, employee, status]);
  if (!employee) return null;
  const model = modelLabel(MODELS, pick);
  return (
    <EmployeeDmScreen
      name={employee.name}
      tone={employee.tone}
      turns={turns}
      folder={pickLabel(FOLDERS, ws)}
      model={model}
      modelLogo={logoOf(pick.model)}
      onOpenSession={(id) => navigation.navigate("Thread", { id })}
      onSend={(text) => {
        const id = startSession(employee.id, text, model, ws);
        navigation.navigate("Thread", { id });
      }}
      onPickFolder={() => navigation.navigate("FolderPicker")}
      onPickModel={() => navigation.navigate("ModelPicker", {})}
    />
  );
}

/* The DM header's status line counts threads: "2 need you" first, since
   that's what you open a DM to find. */
function statusOf(turns: { state: string }[]) {
  const needs = turns.filter((t) => t.state === "needs-you").length;
  const working = turns.filter((t) => t.state === "working").length;
  if (needs) return needs === 1 ? "1 needs you" : `${needs} need you`;
  if (working) return working === 1 ? "Working" : `Working on ${working}`;
  return "Idle";
}

/* The models.dev logo of a model's provider (composer chip). */
function logoOf(model: string) {
  const provider = MODELS.find((m) => m.id === model)?.provider;
  return PROVIDERS.find((p) => p.id === provider)?.logo;
}

function Thread({ navigation, route }: Props<"Thread">) {
  const t = useStore($threads).find((x) => x.id === route.params.id);
  const picks = useStore($threadModel);
  const fallback = useStore($modelPick);
  const title = t?.title;
  const state = t?.state;
  const prs = t?.prs;
  // Plan "Change…" puts this in the composer (a new object each tap).
  const [prefill, setPrefill] = useState<{ text: string }>();
  useEffect(() => playOnOpen(route.params.id), [route.params.id]);
  useLayoutEffect(() => {
    if (!title || !state) return;
    const info = () =>
      navigation.navigate("ThreadInfo", { id: route.params.id });
    navigation.setOptions({
      headerTitle: () => (
        <ThreadHeaderTitle
          title={title}
          state={state}
          prs={prs}
          onPress={info}
        />
      ),
      unstable_headerRightItems: () => [
        {
          type: "button",
          label: "Session info",
          icon: { type: "sfSymbol", name: "info.circle" },
          onPress: info,
        },
      ],
    });
  }, [navigation, route.params.id, title, state, prs]);
  if (!t) return null;
  const pick = picks[t.id] ?? fallback;
  return (
    <ThreadScreen
      t={t}
      model={modelLabel(MODELS, pick)}
      modelLogo={logoOf(pick.model)}
      onApprove={(id) => decide(id, true)}
      onDeny={(id) => decide(id, false)}
      onSend={(text) => reply(t.id, text)}
      onStop={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        stop(t.id);
      }}
      onPickModel={() => navigation.navigate("ModelPicker", { thread: t.id })}
      onOpenSubagent={(a) =>
        navigation.navigate("Subagent", { thread: t.id, id: a.id })
      }
      onOpenBackground={() =>
        navigation.navigate("Background", { thread: t.id })
      }
      onPlan={(a, planId) => {
        void Haptics.selectionAsync();
        if (a === "approve") approvePlan(t.id, planId);
        else if (a === "reject") rejectPlan(t.id, planId);
        else setPrefill({ text: "Change the plan: " });
      }}
      onOpenPlan={() => navigation.navigate("Plan", { thread: t.id })}
      prefill={prefill}
    />
  );
}

function ThreadInfo({ navigation, route }: Props<"ThreadInfo">) {
  const t = useStore($threads).find((x) => x.id === route.params.id);
  if (!t) return null;
  return <ThreadInfoSheet t={t} onDone={() => navigation.goBack()} />;
}

/* Live: the sheet re-reads the store, so a running helper finishes in it. */
function Subagent({ navigation, route }: Props<"Subagent">) {
  const t = useStore($threads).find((x) => x.id === route.params.thread);
  const a = t?.entries
    .flatMap((e) => (e.kind === "agent" ? (e.subagents ?? []) : []))
    .find((x) => x.id === route.params.id);
  if (!a) return null;
  return (
    <SubagentSheet
      a={a}
      onDone={() => navigation.goBack()}
      onOpenThread={(id) => {
        navigation.goBack();
        const emp = $threads.get().find((x) => x.id === id)?.employee.id;
        if (emp) navigation.navigate("Dm", { employeeId: emp });
        navigation.navigate("Thread", { id });
      }}
    />
  );
}

function Plan({ navigation, route }: Props<"Plan">) {
  const t = useStore($threads).find((x) => x.id === route.params.thread);
  const plans =
    t?.entries.flatMap((e) => (e.kind === "agent" && e.plan ? [e.plan] : [])) ??
    [];
  return <PlanSheet plans={plans} onDone={() => navigation.goBack()} />;
}

function Background({ navigation, route }: Props<"Background">) {
  const t = useStore($threads).find((x) => x.id === route.params.thread);
  if (!t) return null;
  return (
    <BackgroundSheet
      jobs={t.jobs ?? []}
      onStop={(id) => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        stopJob(t.id, id);
      }}
      onDone={() => navigation.goBack()}
    />
  );
}

function FolderPicker({ navigation }: Props<"FolderPicker">) {
  const pick = useStore($wsPick);
  return (
    <FolderPickerSheet
      folders={FOLDERS}
      pick={pick}
      onPick={(p) => {
        void Haptics.selectionAsync();
        $wsPick.set(p);
      }}
      onDone={() => navigation.goBack()}
    />
  );
}

function ModelPicker({ navigation, route }: Props<"ModelPicker">) {
  const thread = route.params.thread;
  const picks = useStore($threadModel);
  const fallback = useStore($modelPick);
  const value = (thread && picks[thread]) || fallback;
  return (
    <ModelPickerSheet
      models={MODELS}
      providers={PROVIDERS}
      value={value}
      onPick={(p) => {
        void Haptics.selectionAsync();
        if (thread) $threadModel.set({ ...$threadModel.get(), [thread]: p });
        else $modelPick.set(p);
      }}
      onDone={() => navigation.goBack()}
    />
  );
}

function Mac({ navigation }: Props<"Mac">) {
  const mac = useStore($connections)[0];
  const link = useStore($link);
  if (!mac) return null;
  return (
    <MacSheet
      mac={{
        name: mac.name,
        host: mac.host,
        route: ROUTE_LABEL[mac.route],
        link,
        relay: { version: "0.1.4", latency: "38 ms", lastSeen: "just now" },
        engine: { name: "Hermes", version: "0.19.2" },
        paired: new Date(mac.pairedAt).toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
        }),
      }}
      onRetry={() => $attempt.set($attempt.get() + 1)}
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
        onPress: () => void forgetMacs(),
      },
    ],
  );
}

/* Jump from a request to its DM, and into the thread that asked. */
function openApproval(id: string) {
  const a = $approvals.get().find((x) => x.id === id);
  const t = $threads
    .get()
    .find((x) =>
      x.entries.some((e) => e.kind === "agent" && e.approval?.id === id),
    );
  if (!a) return;
  nav.navigate("Dm", { employeeId: a.employeeId });
  if (t) nav.navigate("Thread", { id: t.id });
}

function Approvals({ navigation }: Props<"Approvals">) {
  const approvals = useStore($approvals);
  return (
    <ApprovalsSheet
      approvals={approvals}
      onApprove={(id) => decide(id, true)}
      onDeny={(id) => decide(id, false)}
      onOpen={(id) => {
        navigation.goBack();
        openApproval(id);
      }}
      onClose={() => navigation.goBack()}
    />
  );
}

function Settings() {
  const mac = useStore($connections)[0];
  const preview = useStore($preview);

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
      <Section title="Prototype · team">
        <Choice
          label="Replay the team from the start"
          on={false}
          onPress={resetTeam}
        />
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
      const { reset, team, open } = applyPreviewQuery(preview[1] ?? "");
      if (reset) void forgetMacs();
      if (team) resetTeam();
      // open=dm:<employee> | thread:<id> | approvals | mac | folder | model | home
      if (open && nav.isReady() && phase === "app") {
        // Pop the root stack only: the tabs keep their own back history.
        const root = nav.getRootState();
        if (root && root.index > 0)
          nav.dispatch({ ...StackActions.popToTop(), target: root.key });
        if (open === "approvals") nav.navigate("Approvals");
        else if (open === "mac") nav.navigate("Mac");
        else if (open === "folder") nav.navigate("FolderPicker");
        else if (open === "model") nav.navigate("ModelPicker", {});
        else if (open.startsWith("dm:"))
          nav.navigate("Dm", { employeeId: open.slice(3) });
        else if (open.startsWith("thread:")) {
          nav.navigate("Dm", { employeeId: "builder" });
          nav.navigate("Thread", { id: open.slice(7) });
        } else nav.navigate("Tabs", { screen: "Home" });
      }
      return;
    }
    const offer = parsePairingUrl(url);
    if (offer && phase === "onboarding" && nav.isReady())
      nav.navigate("Connecting", { offer });
  }, [url, phase]);
}

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
              <Stack.Screen
                name="ThreadInfo"
                component={ThreadInfo}
                options={SHEET}
              />
              <Stack.Screen
                name="Subagent"
                component={Subagent}
                options={SHEET}
              />
              <Stack.Screen name="Plan" component={Plan} options={SHEET} />
              <Stack.Screen
                name="Background"
                component={Background}
                options={SHEET}
              />
              <Stack.Screen
                name="Approvals"
                component={Approvals}
                options={{ headerShown: false, presentation: "modal" }}
              />
              <Stack.Screen
                name="Mac"
                component={Mac}
                options={{ headerShown: false, presentation: "modal" }}
              />
              <Stack.Screen
                name="FolderPicker"
                component={FolderPicker}
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
