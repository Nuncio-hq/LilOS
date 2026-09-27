import { formatDiagnostics, toStatusComponents } from "@lilos/client-runtime";
import {
  type EngineProfile,
  HireDialog,
  type HireDraft,
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
import {
  HIRE_TEMPLATES,
  hireEmployee,
  listHirableProfiles,
} from "./lib/employees";
import { useAtom } from "./lib/hooks";
import { toUiEmployee } from "./lib/mapping";
import { ME } from "./lib/me";
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
  engineModels,
  navOpen,
  relay,
  sessionModels,
} from "./lib/runtime";
import { toast } from "./lib/toast";
import { DmPage } from "./pages/dm";
import { IndexPage } from "./pages/index";

function AppShell() {
  const [theme, setTheme] = useTheme();
  const employees = useAtom(relay.employees);
  const relayState = useAtom(relay.state);
  const [statusOpen, setStatusOpen] = useState(false);
  const nav = useAtom(navOpen);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const toastMsg = useAtom(toast);
  const dmMatch = /^\/dm\/([^/]+)/.exec(pathname);
  const view: { kind: "channel" | "dm"; id: string } = dmMatch
    ? { kind: "dm", id: decodeURIComponent(dmMatch[1]) }
    : { kind: "dm", id: "" };

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
  // #85 AC-4: a build running the fake engine is labeled — never indistinguishable
  // from a release running Hermes.
  const buildLabel =
    statusPoll.result?.engine?.name === "engine-fake"
      ? "dev · fake engine"
      : undefined;
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
      HIRE_TEMPLATES.map((t) => ({
        ...t,
        model: t.model || defaultModel || catalog[0]?.id || "",
      })),
    [catalog, defaultModel],
  );
  const openHire = () => {
    setHireError(null);
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
    <div className="flex h-dvh min-h-0 bg-background text-foreground">
      <Sidebar
        realApp
        navOpen={nav}
        hiddenWhenClosed={false}
        me={ME}
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
        buildLabel={buildLabel}
        onOpenStatus={() => setStatusOpen(true)}
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
          onClose={() => setHireOpen(false)}
          onHire={(d, profile) => hire(d, profile)}
        />
      )}
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
const routeTree = rootRoute.addChildren([indexRoute, dmRoute, threadRoute]);

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
