import { formatDiagnostics, toStatusComponents } from "@lilos/client-runtime";
import { Sidebar, StatusDialog, useTheme } from "@lilos/ui";
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
import { useEffect, useMemo, useState } from "react";
import { employeeBadges } from "./lib/badges";
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
  navOpen,
  relay,
  sessionModels,
} from "./lib/runtime";
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
  const dmMatch = /^\/dm\/([^/]+)/.exec(pathname);
  const view: { kind: "channel" | "dm"; id: string } = dmMatch
    ? { kind: "dm", id: decodeURIComponent(dmMatch[1]) }
    : { kind: "dm", id: "" };

  const statusPoll = useAtom(relay.status);
  const fatal = useAtom(relay.fatal);
  const uiEmployees = useMemo(() => employees.map(toUiEmployee), [employees]);
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
          openConversationId: () =>
            openConversationFromPath(router.state.location.pathname),
          inForeground: () =>
            document.visibilityState === "visible" && document.hasFocus(),
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
        badges={badges}
        status={comps}
        buildLabel={buildLabel}
        onOpenStatus={() => setStatusOpen(true)}
      />
      <Outlet />
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
