import { threadStatus } from "@lilos/client-runtime";
import {
  type Employee,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type Project,
} from "@lilos/contracts/app";
import type { AgentDescriptor, DescribeResult } from "@lilos/contracts/engine";
import {
  agentDisplayName,
  agentTone,
  folderLabel,
  type V3Agent,
  type V3Data,
  type V3Project,
} from "@lilos/ui";
import { atom, computed, onMount, type ReadableAtom } from "nanostores";
import { appConfig } from "../lib/config";
import { HIRE_TEMPLATES } from "../lib/employees";
import { folders } from "../lib/folders";
import { currentCompany, currentName, osFullName, profile } from "../lib/me";
import {
  asks,
  ceoThreadId,
  companyCeoId,
  engine as engineClient,
  engineDefaultModel,
  engineDefaultProvider,
  engineModels,
  engineProviders,
  modelVisibility,
  relay,
  sessionModels,
  sessionSignals,
} from "../lib/runtime";
import { modelRowStore } from "./models";
import { profileKey, profileStore } from "./profiles";
import {
  isDefaultRuntime,
  modelLabelFor,
  runtimeCatalogs,
  runtimeRows,
} from "./runtimes";
import { v3SettingsSlice } from "./settings-data";
import { lastChats, v3ArchivedThreads, v3Asks, v3Threads } from "./threads";
import { v3Goals, v3Tickets, v3Updates } from "./tickets";
import { type WeekCounts, weekByAgent } from "./week";

/* The company as the relay knows it, in the shape the v3 pages read. A
   computed store: pages re-render when the company changes, not on every
   streamed word (see `statusKey`). What the relay cannot tell stays absent
   (no tickets, goals, updates, spend, skills, memory, CEO) and the pages hide
   those parts. */

/* Minute clock for "minutes running": one timer, only while something reads. */
const minute = atom(Date.now());
onMount(minute, () => {
  const t = setInterval(() => minute.set(Date.now()), 60_000);
  return () => clearInterval(t);
});

/* Employees and projects have no colour of their own: `agentTone`
   (packages/ui) is the one table every surface shares (#872). */

/** Employees and projects have no colour of their own: a stable one from the
    name (or a project's id), so a person or a project looks the same on every
    screen (31-polynomial hash). */
const toneOf = agentTone;

/** The relay's projects, oldest first so the sidebar only ever grows at its
    end. */
export function projectRows(projects: readonly Project[]): V3Project[] {
  return [...projects]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((p) => ({
      id: p.id,
      name: p.name,
      key: p.key,
      tone: toneOf(p.id),
      folder: p.folder,
      about: p.about,
    }));
}

/** The engine can re-read its model catalog: its `models` capability says
    `refreshable` (no control without a handler, D-#19). */
function canRefreshModels(description: DescribeResult | undefined): boolean {
  const detail = description?.capabilities.find((c) => c.id === "models")
    ?.detail as { refreshable?: boolean } | undefined;
  return detail?.refreshable === true;
}

/** `profile`: what the engine says about the employee's profile, when it has
    said. Its persona is the instructions (the record's copy is only the one
    the harness seeds a new profile with), and its description the one line
    the record has no field for. */
function toAgent(
  e: Employee,
  runtime: string | undefined,
  profile: AgentDescriptor | undefined,
  lastChat: V3Agent["lastChat"],
  week: WeekCounts,
): V3Agent {
  /* #872: the untouched stock agent reads "Hermes" — the raw record's
     runtime/profile decide, never the resolved row's. */
  const name = agentDisplayName(e);
  return {
    id: e.id,
    name,
    tone: toneOf(name),
    role: e.role,
    /* Absent reports to the owner; the page shows the profile name (D-#775). */
    ...(e.reportsTo ? { reportsTo: e.reportsTo } : {}),
    hired: new Date(e.createdAt).toLocaleDateString([], {
      day: "numeric",
      month: "short",
    }),
    ...(runtime ? { runtime } : {}),
    ...(e.profile ? { profile: e.profile } : {}),
    /* The owning runtime's catalog labels it — never the default engine's
       list on an ACP agent (#872). */
    model: modelLabelFor(e.runtime, e.model),
    ...(e.model ? { modelId: e.model } : {}),
    ...(e.effort ? { effort: e.effort } : {}),
    ...(lastChat ? { lastChat } : {}),
    /* The engine's live description wins; the record's copy answers when
       the runtime hasn't been described (never started, D-#866) or lost
       its persona to a restart (#872). */
    ...((profile?.description ?? e.description)
      ? { description: profile?.description ?? e.description }
      : {}),
    ...(e.muted ? { muted: true } : {}),
    instructions: (profile?.soul ?? e.instructions)
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean),
    /* Always present, including zeros: the column is a real count (D-#19).
       Stuck counts threads whose stuckAt falls this week (issue #775),
       including ones that have recovered. Colour is only a count above zero. */
    weekThreads: week,
  };
}

function todayText(now: number): string {
  const parts = new Intl.DateTimeFormat([], {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")}, ${get("day")} ${get("month")}`;
}

let store: ReadableAtom<V3Data> | undefined;

/** The one store (built on first read: `relay` binds at boot, so the
    computed can't exist at import time). */
export function v3DataStore(): ReadableAtom<V3Data> {
  if (store) return store;
  /* A thread's status moves rarely but the models/signals it reads change on
     every streamed word: this key changes only when some status does, so the
     thread rows below rebuild on real change, not per word. */
  const statusKey = computed(
    [relay.conversations, sessionModels, sessionSignals],
    (cs, models, signals) =>
      cs
        .map((c) =>
          c.engineRef
            ? threadStatus(c, models[c.engineRef], signals[c.engineRef])
            : "idle",
        )
        .join(","),
  );
  /* The runtime roster the harness reports, with each runtime's own model
     catalog and field list folded in (D-#761, #872 — see v3/runtimes.ts). */
  const runtimeList = runtimeRows();
  const company = computed(
    [profile, osFullName],
    () => [currentName(), currentCompany()] as const,
  );
  store = computed(
    [
      relay.employees,
      relay.conversations,
      relay.conversationSummaries,
      relay.channels,
      asks,
      statusKey,
      minute,
      runtimeList,
      company,
      folders,
      modelRowStore(),
      runtimeCatalogs(),
      v3SettingsSlice,
      profileStore(),
      engineModels,
      engineDefaultModel,
      engineDefaultProvider,
      engineProviders,
      modelVisibility,
      engineClient.description,
      relay.projects,
      relay.goals,
      relay.tickets,
      relay.updates,
      companyCeoId,
      ceoThreadId,
      appConfig,
    ],
    (
      employees,
      conversations,
      summaries,
      channels,
      askRows,
      _status,
      now,
      runtimeList,
      [me, companyName],
      folderRows,
      modelRows,
      runtimeCats,
      settingsSlice,
      profiles,
      catalog,
      defaultModel,
      defaultProvider,
      providers,
      visibility,
      description,
      projects,
      goals,
      tickets,
      updates,
      holderId,
      standingId,
      bootCfg,
    ): V3Data => {
      const src = {
        now,
        conversations,
        summaries,
        channels,
        employees,
        models: sessionModels.get(),
        signals: sessionSignals.get(),
        asks: askRows,
      };
      const reachable = folderRows.filter((f) => !f.missing);
      const chats = lastChats(src);
      const weeks = weekByAgent(src);
      return {
        company: companyName,
        me,
        today: todayText(now),
        ...(holderId ? { ceoId: holderId } : {}),
        agents: employees.map((e) =>
          toAgent(
            e,
            /* #872: `V3Agent.runtime` means "owned by a NON-default
               runtime" — a record stamped with the default id (`"hermes"`,
               a hire before the stamp canonicalised) and an unstamped
               record both read absent, so `runtime` set always means a
               coding runtime whose own row governs the page. */
            isDefaultRuntime(e.runtime) ? undefined : e.runtime,
            e.profile
              ? profiles.byProfile[profileKey(e.runtime, e.profile)]
              : undefined,
            chats.get(e.id),
            weeks.get(e.id) ?? { finished: 0, failed: 0, stuck: 0 },
          ),
        ),
        connectors: [],
        ...(runtimeList ? { runtimes: runtimeList } : {}),
        projects: projectRows(projects),
        goals: v3Goals(goals),
        tickets: v3Tickets(tickets, now),
        threads: v3Threads(src, standingId),
        archivedThreads: v3ArchivedThreads(src, standingId),
        asks: v3Asks(src),
        updates: v3Updates(updates),
        browser: { tabs: [], bookmarks: [] },
        modelChoices: modelRows.map((r) => r.label),
        hireTemplates: HIRE_TEMPLATES,
        ...(catalog.length
          ? {
              modelCatalog: {
                options: catalog,
                ...(defaultModel ? { defaultModel } : {}),
                ...(defaultProvider ? { defaultProvider } : {}),
                ...(providers.length
                  ? {
                      providers: providers.map((p) => ({
                        id: p.id,
                        name: p.name ?? p.id,
                      })),
                    }
                  : {}),
                visibility,
                ...(canRefreshModels(description) ? { refreshable: true } : {}),
              },
            }
          : {}),
        /* #872: the composer's picker follows the selected agent — these
           are the non-default runtimes' own catalogs, keyed by id. */
        ...(Object.keys(runtimeCats).length
          ? { modelCatalogs: runtimeCats }
          : {}),
        // A chat opens on the access you pick: Settings' default is the start.
        chatAccess: true,
        attachLimits: {
          maxFileBytes: MAX_ATTACHMENT_BYTES,
          maxFiles: MAX_ATTACHMENTS_PER_MESSAGE,
        },
        ...(profiles.fields.length ? { agentFields: profiles.fields } : {}),
        ...(reachable.length
          ? {
              folders: reachable.map((f) => ({
                path: f.path,
                label: folderLabel(f, folderRows),
                // [] = probed, not a repo (the box says "direct · no git").
                branch: f.branches.length ? f.branches[0] : null,
              })),
            }
          : {}),
        /* Tickets are real records (D-#776) and the company layer is paused
           (D-#836): `features.company` off makes the shared shell show the
           daily Home and route hidden pages home — records keep answering
           underneath. `?company=1` or a LILOS_COMPANY=1 stack sets it back. */
        features: { tickets: true, company: bootCfg?.company === true },
        ...settingsSlice,
      };
    },
  );
  return store;
}
