import {
  formatDiagnostics,
  type StatusRow,
  toStatusComponents,
} from "@lilos/client-runtime";
import type { DesktopAbout } from "@lilos/contracts/app";
import type { V3Data } from "@lilos/ui";
import { atom, computed, onMount, type ReadableAtom } from "nanostores";
import { toastOnFail } from "../lib/actions";
import { connectApproved } from "../lib/connect";
import { folders, refreshFolders } from "../lib/folders";
import { hostEditors, type OsEditor } from "../lib/host";
import {
  engine as engineClient,
  engineModels,
  engineProviders,
  modelVisibility,
  relay,
} from "../lib/runtime";
import {
  $scheduledTasks,
  refreshScheduledTasks,
  watchSchedules,
} from "../lib/schedules";
import { aboutLines, defaultAccess, defaultEditor } from "../settings/state";
import { modelLabel, modelRows } from "./models";
import {
  deviceOf,
  engineOf,
  modelsOf,
  relayOf,
  scheduleOf,
} from "./settings-map";

/* What v3 Settings, the schedules and first run read, from the real stores.
   One store for all four: `settings` (profile-free: the company and your
   name are the shell's), `devices`, `schedules`, `setUp`. It starts its
   sources when something first subscribes (after boot, since `relay` only
   exists then) and lets go when the last subscriber does. */

type Slice = Pick<V3Data, "settings" | "devices" | "schedules" | "setUp">;

/** First run is done once Welcome (or "Set up later") ran. The key is the one
    the pre-v3 first-run page wrote, so an install that finished it stays
    set up. */
const ONBOARDED_KEY = "lilos-onboarded";

export const onboarded = atom(!!localStorage.getItem(ONBOARDED_KEY));

export function markOnboarded(): void {
  localStorage.setItem(ONBOARDED_KEY, "1");
  onboarded.set(true);
}

/** The editors this Mac has; null until the host answers (or has none). */
export const detectedEditors = atom<OsEditor[] | null>(null);
const appAbout = atom<DesktopAbout | null>(null);
/** Ticks each minute while mounted: "4m ago" and "Today 14:00" age. */
const clock = atom(Date.now());

/* First run shows this many models (the engine's default first); the pickers
   hold the rest, which a catalog of hundreds should not pour into one step. */
const FIRST_RUN_MODELS = 8;

function build(): Slice {
  const now = Date.now();
  const threadIds = new Set(relay.conversations.get().map((c) => c.id));
  const status = relay.status.get();
  const connection = relay.state.get();
  const rows: StatusRow[] = toStatusComponents({
    result: status.result,
    connection,
    fatal: relay.fatal.get(),
  });
  const engine = engineOf(rows, status.result);
  const catalog = engineModels.get();
  const visibility = modelVisibility.get();

  const editors = detectedEditors.get();
  const editor =
    editors?.find((e) => e.id === defaultEditor.get()) ?? editors?.[0];

  const { version, build: detail } = aboutLines({
    app: appAbout.get(),
    versions: status.result?.versions,
  });

  /* #884 round 1: the engine's own Smart/Manual/Off policy no longer
     reaches the app at all — the harness pins the engine to the mode
     that surfaces every ask, so "Ask" here always means asking. */
  const connectRows = status.result?.connect;
  const connect =
    connectRows === undefined
      ? undefined
      : {
          engine: engine.name,
          approved: connectApproved.get() === true,
          rows: connectRows.length
            ? connectRows
            : relay.employees
                .get()
                .filter((e) => e.profile)
                .map((e) => ({
                  profile: e.profile as string,
                  employee: e.name,
                  state: "not-connected" as const,
                })),
        };

  // The engine's default model leads; the pickers hold the rest.
  const shown = modelRows(catalog, visibility);
  const standard = modelLabel("");
  const firstModels = [
    ...shown.filter((r) => r.label === standard),
    ...shown.filter((r) => r.label !== standard),
  ]
    .slice(0, FIRST_RUN_MODELS)
    .map((r) => ({
      label: r.label,
      ...(r.label === standard ? { note: "The engine's default." } : {}),
    }));

  return {
    settings: {
      approvals: defaultAccess.get(),
      ...(editor && editors
        ? { editor: editor.name, editors: editors.map((e) => e.name) }
        : {}),
      models: modelsOf(catalog, engineProviders.get(), visibility),
      engine,
      relay: relayOf(rows),
      ...(version
        ? { about: { version: detail ? `${version} · ${detail}` : version } }
        : {}),
      diagnostics: formatDiagnostics({
        result: status.result,
        connection,
        fatal: relay.fatal.get(),
        error: status.error,
        app: { name: "LilOS", version },
      }),
      ...(connect ? { connect } : {}),
      firstRun: {
        models: firstModels,
        folders: folders
          .get()
          .filter((f) => !f.missing)
          .map((f) => ({
            path: f.path,
            ...(f.branches.length > 0 ? { note: "Git repository" } : {}),
          })),
      },
    },
    devices: relay.devices.get().map((d) => deviceOf(d, now)),
    // The relay keeps tasks in the order they were touched; the list should
    // not shuffle when one is paused.
    schedules: [...$scheduledTasks.get()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => scheduleOf(t, threadIds, new Date(now))),
    setUp: onboarded.get(),
  };
}

const INITIAL: Slice = {
  settings: {
    approvals: "ask",
    models: [],
    engine: { name: "Engine", unnamed: true, state: "starting" },
    relay: { state: "starting" },
  },
  devices: [],
  schedules: [],
  setUp: false,
};

const slice = atom<Slice>(INITIAL);

onMount(slice, () => {
  const refresh = () => slice.set(build());
  /* A schedule links the thread its last run made, so the slice needs which
     threads exist, not how each one is doing: keyed by the ids, a turn
     starting or a thread being read (a `conversation.updated`) does not
     rebuild the diagnostics, model lists and cron walks. Built here, not at
     module level: `relay` exists only after boot. */
  const threadIdKey = computed(relay.conversations, (cs) =>
    cs.map((c) => c.id).join(","),
  );
  const sources: { listen: (cb: () => void) => () => void }[] = [
    relay.devices,
    relay.status,
    relay.state,
    relay.fatal,
    relay.employees,
    threadIdKey,
    $scheduledTasks,
    defaultAccess,
    defaultEditor,
    engineClient.description,
    modelVisibility,
    engineModels,
    engineProviders,
    connectApproved,
    detectedEditors,
    appAbout,
    folders,
    onboarded,
    clock,
  ];
  const stops = sources.map((s) => s.listen(refresh));

  watchSchedules();
  toastOnFail("Couldn't load scheduled tasks", refreshScheduledTasks());
  void refreshFolders().catch(() => {});
  void hostEditors().then((e) => detectedEditors.set(e));
  void window.lilos
    ?.about?.()
    .then((a) => appAbout.set(a))
    .catch(() => {});
  const tick = window.setInterval(() => clock.set(Date.now()), 60_000);

  refresh();
  return () => {
    for (const stop of stops) stop();
    window.clearInterval(tick);
  };
});

export const v3SettingsSlice: ReadableAtom<Slice> = slice;
