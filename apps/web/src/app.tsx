import {
  formatDiagnostics,
  RelayError,
  toStatusComponents,
} from "@lilos/client-runtime";
import {
  type EngineProfile,
  HireDialog,
  type HireDraft,
  PairPhoneDialog,
  type PairPhoneState,
  Sidebar,
  StatusDialog,
  useTheme,
} from "@lilos/ui";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { employeeBadges } from "./lib/badges";
import { buildLabel } from "./lib/build-label";
import { connectApproved, requestConnect } from "./lib/connect";
import {
  HIRE_TEMPLATES,
  hireEmployee,
  listHirableProfiles,
} from "./lib/employees";
import { appFrameClass } from "./lib/frame";
import { useAtom } from "./lib/hooks";
import { toUiEmployee } from "./lib/mapping";
import { currentCompany, currentMe, osFullName, profile } from "./lib/me";
import {
  openConversationFromPath,
  routeForConversation,
  watchNotifications,
} from "./lib/notify";
import {
  bootError,
  booted,
  engine,
  engineDefaultModel,
  engineDefaultProvider,
  engineModels,
  navOpen,
  relay,
  sessionModels,
} from "./lib/runtime";
import { say, toast } from "./lib/toast";
import { DmPage } from "./pages/dm";
import { IndexPage } from "./pages/index";
import { SettingsPane } from "./settings/pane";
import { isSettingsShortcut } from "./settings/state";

function AppShell() {
  const [theme, setTheme] = useTheme();
  // #232: the window's vibrancy/appearance must track the app theme or the
  // sidebar material turns unreadable in the mismatched combination.
  useEffect(() => {
    window.lilos?.setThemeSource?.(theme);
  }, [theme]);
  const employees = useAtom(relay.employees);
  const relayState = useAtom(relay.state);
  const [statusOpen, setStatusOpen] = useState(false);
  /* Pair phone (#153): `ready` carries the relay's one-time grant;
     `no-remote` is the `tailscale_unavailable` answer. `pairBaseline`
     remembers the device ids at open so `devices.changed` flips the dialog
     to `paired` the moment a phone exchanges its grant. */
  const [pairPhone, setPairPhone] = useState<PairPhoneState | null>(null);
  const pairedDevices = useAtom(relay.devices);
  const pairBaseline = useRef<Set<string>>(new Set());
  const openPairPhone = async () => {
    pairBaseline.current = new Set(relay.devices.get().map((d) => d.id));
    try {
      const offer = await relay.pairingOffer();
      setPairPhone({
        kind: "ready",
        offer: {
          host: offer.host,
          code: offer.code,
          name: offer.name,
          expiresAt: offer.expiresAt,
        },
      });
    } catch (e) {
      if (e instanceof RelayError && e.code === "tailscale_unavailable") {
        setPairPhone({ kind: "no-remote" });
      } else {
        say("Couldn't reach the relay — try again.");
      }
    }
  };
  // A new device while the dialog is open means the phone spent its grant.
  useEffect(() => {
    if (pairPhone?.kind !== "ready") return;
    const fresh = pairedDevices.find((d) => !pairBaseline.current.has(d.id));
    if (fresh) {
      setPairPhone({
        kind: "paired",
        device: fresh.name,
        macName: pairPhone.offer.name,
      });
    }
  }, [pairedDevices, pairPhone]);
  const nav = useAtom(navOpen);
  // #118: identity surfaces re-render when the profile or OS name lands.
  useAtom(profile);
  useAtom(osFullName);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const toastMsg = useAtom(toast);
  const dmMatch = /^\/dm\/([^/]+)/.exec(pathname);
  const view: { kind: "channel" | "dm"; id: string } = dmMatch
    ? { kind: "dm", id: decodeURIComponent(dmMatch[1]) }
    : { kind: "dm", id: "" };
  /* #246: in Focus the window is one column and the sidebar opens as an
     overlay — the same layout the prototype uses. */
  const focus = pathname.endsWith("/focus");

  const statusPoll = useAtom(relay.status);
  const fatal = useAtom(relay.fatal);
  // Real system.status legs (poll keeps them fresh); falls back to socket
  // states while the relay is unreachable (#53, #85).
  const comps = useMemo(
    () =>
      toStatusComponents({
        result: statusPoll.result,
        connection: relayState,
        fatal,
      }),
    [statusPoll, relayState, fatal],
  );
  // #99: presence follows the engine — no green dot beside "Engine down".
  const engineDown = comps.some((c) => c.id === "engine" && c.state === "down");
  const uiEmployees = useMemo(
    () => employees.map((e) => toUiEmployee(e, engineDown)),
    [employees, engineDown],
  );
  // #85 AC-4 / #141: the label follows the engine the harness actually runs
  // (system.status engine name), not the build identity.
  const label = buildLabel(statusPoll.result?.engine?.name);
  // live badges: running turns + open approvals per employee (AC-3, #32)
  const models = useAtom(sessionModels);
  const convs = useAtom(relay.conversations);
  const channels = useAtom(relay.channels);
  const badges = useMemo(
    () => employeeBadges(channels, convs, models),
    [channels, convs, models],
  );

  /* #115 hire flow: the + affordance exists only while the engine declares
     the `agents` capability (D-#19). The model list + default come from
     `models.list` (D-#85 — no hardcoded catalog, no LilOS default). */
  const desc = useAtom(engine.description);
  const canHire = desc?.capabilities.some((c) => c.id === "agents") ?? false;
  const catalog = useAtom(engineModels);
  const defaultModel = useAtom(engineDefaultModel);
  const defaultProvider = useAtom(engineDefaultProvider);
  /* #132: Settings — ⌘,/Ctrl+, anywhere, the desktop menu's matching item
     (lilos:open-app-settings), or the sidebar gear opens the one screen. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSettingsShortcut(e)) return;
      e.preventDefault();
      setSettingsOpen(true);
    };
    window.addEventListener("keydown", onKey);
    const offBridge = window.lilos?.onOpenSettings?.(() =>
      setSettingsOpen(true),
    );
    return () => {
      window.removeEventListener("keydown", onKey);
      offBridge?.();
    };
  }, []);

  const [hireOpen, setHireOpen] = useState(false);
  const [hireError, setHireError] = useState<string | null>(null);
  const [hirePending, setHirePending] = useState(false);
  /* Single-flight hire: state only flips the button's disabled attr on the
     next render, so a second click landing inside the same tick still finds
     the ref already set. */
  const hireBusy = useRef(false);
  const [engineProfiles, setEngineProfiles] = useState<EngineProfile[]>([]);
  const hireTemplates = useMemo(
    () =>
      HIRE_TEMPLATES.map((t) => {
        const model = t.model || defaultModel || catalog[0]?.id || "";
        /* The model is `{provider?, id}`: a template that left it unset
           inherits the engine default's provider; a bare-id template
           resolves to the first catalog row with that id (#92 AC-8). */
        const row =
          !t.model && model === defaultModel && defaultProvider !== undefined
            ? catalog.find(
                (m) => m.id === model && m.provider === defaultProvider,
              )
            : catalog.find((m) => m.id === model);
        return { ...t, model, provider: row?.provider };
      }),
    [catalog, defaultModel, defaultProvider],
  );
  /* #339: the hire dialog's "Connect to LilOS" checkbox — on by default,
     rendered only when the engine reports connect rows (Hermes). */
  const [hireConnect, setHireConnect] = useState(true);
  const openHire = () => {
    setHireError(null);
    setHireConnect(true);
    setHireOpen(true);
    // Fresh roster each open — a profile created or freed elsewhere shows up.
    void listHirableProfiles()
      .then(setEngineProfiles)
      .catch(() => setEngineProfiles([]));
  };
  const hire = (d: HireDraft, profile: string | null) => {
    if (hireBusy.current) return;
    hireBusy.current = true;
    setHirePending(true);
    void hireEmployee(d, profile)
      .then((emp) => {
        // #339: a checked "Connect to LilOS" grants the one-time approval —
        // the reconciler picks the new profile up on its next pass.
        if (hireConnect && connectApproved.get() !== true)
          void requestConnect().catch(() => {});
        setHireOpen(false);
        void navigate({
          to: "/dm/$employeeId",
          params: { employeeId: emp.id },
        });
      })
      .catch((e) => setHireError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        hireBusy.current = false;
        setHirePending(false);
      });
  };

  // Notifications (#32): engine events -> macOS notifications when the
  // conversation isn't in view; a notification click opens that conversation.
  useEffect(() => {
    const bridge = window.lilos;
    if (!bridge) return;
    const unsubs: Array<() => void> = [];
    if (bridge.notifications) {
      unsubs.push(
        watchNotifications({
          onEvent: (fn) => engine.onEvent(fn),
          context: () => ({
            conversations: relay.conversations.get(),
            channels: relay.channels.get(),
            employees: relay.employees.get(),
          }),
          isRequestOpen: (requestId) =>
            Object.values(sessionModels.get()).some((m) =>
              m.openRequests.some((r) => r.requestId === requestId),
            ),
          openAsks: () =>
            Object.entries(sessionModels.get()).flatMap(([sessionId, m]) =>
              m.openRequests.map((r) => ({
                sessionId,
                requestId: r.requestId,
                request: r.request,
              })),
            ),
          onOpenAsksChange: (fn) => sessionModels.subscribe(fn),
          openConversationId: () =>
            openConversationFromPath(router.state.location.pathname),
          inForeground: () =>
            document.visibilityState === "visible" && document.hasFocus(),
          onViewChange: (fn) => {
            const un = router.subscribe("onResolved", fn);
            document.addEventListener("visibilitychange", fn);
            window.addEventListener("focus", fn);
            window.addEventListener("blur", fn);
            return () => {
              un();
              document.removeEventListener("visibilitychange", fn);
              window.removeEventListener("focus", fn);
              window.removeEventListener("blur", fn);
            };
          },
          post: (n) => bridge.notifications?.post(n),
        }),
      );
    }
    if (bridge.onOpenConversation) {
      unsubs.push(
        bridge.onOpenConversation((conversationId) => {
          const params = routeForConversation(conversationId, {
            conversations: relay.conversations.get(),
            channels: relay.channels.get(),
          });
          /* A notification click opens the session in the thread panel —
             the quick peek (#195 AC-3); its ↗ is the way into Focus. */
          if (params) {
            void navigate({
              to: "/dm/$employeeId/$conversationId",
              params,
            });
          }
        }),
      );
    }
    return () => {
      for (const u of unsubs) u();
    };
  }, [navigate]);

  return (
    <div
      className={appFrameClass({
        desktop: window.lilos?.isDesktop === true,
        focus,
      })}
    >
      {/* The sidebar's dim backdrop: narrow windows in every view, and at
          any width in Focus where the sidebar is an overlay (prototype). */}
      {nav && (
        <button
          type="button"
          aria-label="Close sidebar"
          className="fixed inset-0 z-30 cursor-default bg-black/30 lg:hidden"
          onClick={() => navOpen.set(false)}
        />
      )}
      {nav && focus && (
        <button
          type="button"
          aria-label="Close sidebar"
          className="fixed inset-0 z-30 hidden cursor-default bg-black/30 lg:block"
          onClick={() => navOpen.set(false)}
        />
      )}
      <Sidebar
        realApp
        navOpen={nav}
        hiddenWhenClosed={focus}
        me={currentMe()}
        company={currentCompany()}
        companyChannels={[]}
        projects={[]}
        folders={[]}
        employees={uiEmployees}
        view={view}
        theme={theme}
        onSetTheme={setTheme}
        isProjectDefaultOpen={() => false}
        onCloseNav={() => navOpen.set(false)}
        onGoChannel={() => {}}
        onGoDM={(id) => {
          navOpen.set(false);
          void navigate({
            to: "/dm/$employeeId",
            params: { employeeId: id },
          });
        }}
        onOpenTickets={() => {}}
        onAddFolder={() => {}}
        onHire={canHire ? openHire : undefined}
        badges={badges}
        status={comps}
        buildLabel={label}
        onOpenStatus={() => setStatusOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onPairPhone={openPairPhone}
      />
      <Outlet />
      {hireOpen && (
        <HireDialog
          initial={hireTemplates[0]}
          templates={hireTemplates}
          profiles={engineProfiles}
          models={catalog}
          allChannels={[]}
          usedProfiles={employees.map((e) => e.profile)}
          error={hireError ?? undefined}
          pending={hirePending}
          connect={
            statusPoll.result?.connect
              ? { checked: hireConnect, onChange: setHireConnect }
              : undefined
          }
          onClose={() => setHireOpen(false)}
          onHire={(d, profile) => hire(d, profile)}
        />
      )}
      {pairPhone && (
        <PairPhoneDialog
          state={pairPhone}
          devices={pairedDevices}
          onNewCode={() => void openPairPhone()}
          onRevokeDevice={(id) =>
            void relay
              .revokeDevice(id)
              .catch(() => say("Couldn't remove that phone — try again."))
          }
          onTurnOff={() => {
            void relay.pairingDisable().catch(() => {});
            setPairPhone(null);
          }}
          onClose={() => setPairPhone(null)}
          onCopied={say}
        />
      )}
      {settingsOpen && <SettingsPane onClose={() => setSettingsOpen(false)} />}
      {statusOpen && (
        <StatusDialog
          components={comps}
          diagnostics={formatDiagnostics({
            result: statusPoll.result,
            connection: relayState,
            fatal,
            error: statusPoll.error,
            app: { name: "LilOS" },
          })}
          onClose={() => setStatusOpen(false)}
          onCopied={() => {}}
        />
      )}
      {/* One-line notices (attach rejections, failed sends) — same look as
          the prototype's toast. */}
      {toastMsg && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-foreground px-4 py-2 text-background text-sm shadow-lg">
          {toastMsg}
        </div>
      )}
    </div>
  );
}

function BootScreen() {
  const ready = useAtom(booted);
  const error = useAtom(bootError);
  if (error) {
    return (
      <div className="grid h-dvh place-items-center bg-background p-6">
        <div className="max-w-md rounded-xl border border-red-200 bg-red-50/60 p-5 text-sm">
          <div className="font-semibold text-red-900">
            LilOS could not start
          </div>
          <p className="mt-1 text-red-800">{error}</p>
          <p className="mt-2 text-muted-foreground text-xs">
            Run <code>bun run dev</code> in apps/web to boot relay + engine +
            this page together.
          </p>
        </div>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="grid h-dvh place-items-center bg-background text-muted-foreground text-sm">
        Connecting to the local relay…
      </div>
    );
  }
  return <RouterProvider router={router} />;
}

const rootRoute = createRootRoute({ component: AppShell });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexPage,
});
const dmRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dm/$employeeId",
  component: DmPage,
});
const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dm/$employeeId/$conversationId",
  component: DmPage,
});
/* `/focus` opens the session in Focus — same page component, Focus reads
   the suffix itself (#114). */
const focusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dm/$employeeId/$conversationId/focus",
  component: DmPage,
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  dmRoute,
  threadRoute,
  focusRoute,
]);

// file:// gives the app a path URL that matches no route; hash history keeps
// navigation inside the page. http(s) dev and _electron test pages keep
// browser history.
export const router = createRouter({
  routeTree,
  history:
    window.location.protocol === "file:" ? createHashHistory() : undefined,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return <BootScreen />;
}
