import { threadStatus } from "@lilos/client-runtime";
import {
  type Employee,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type Project,
} from "@lilos/contracts/app";
import type { AgentDescriptor, DescribeResult } from "@lilos/contracts/engine";
import {
  folderLabel,
  type V3Agent,
  type V3Data,
  type V3Project,
  type V3Tone,
} from "@lilos/ui";
import { atom, computed, onMount, type ReadableAtom } from "nanostores";
import { HIRE_TEMPLATES } from "../lib/employees";
import { folders } from "../lib/folders";
import { currentCompany, currentName, osFullName, profile } from "../lib/me";
import {
  asks,
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
import { modelLabel, modelRowStore } from "./models";
import { profileStore } from "./profiles";
import { v3SettingsSlice } from "./settings-data";
import { lastChats, v3ArchivedThreads, v3Asks, v3Threads } from "./threads";
import { v3Goals, v3Tickets } from "./tickets";
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

const TONES: V3Tone[] = ["c", "b", "r", "m", "s", "d"];

/** Employees and projects have no colour of their own: a stable one from the
    name (or a project's id), so a person or a project looks the same on every
    screen (31-polynomial hash). */
function toneOf(name: string): V3Tone {
  let x = 0;
  for (const ch of name.toLowerCase())
    x = (Math.imul(x, 31) + ch.charCodeAt(0)) >>> 0;
  return TONES[x % TONES.length];
}

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
  return {
    id: e.id,
    name: e.name,
    tone: toneOf(e.name),
    role: e.role,
    /* Absent reports to the owner; the page shows the profile name (D-#775). */
    ...(e.reportsTo ? { reportsTo: e.reportsTo } : {}),
    hired: new Date(e.createdAt).toLocaleDateString([], {
      day: "numeric",
      month: "short",
    }),
    ...(runtime ? { runtime } : {}),
    ...(e.profile ? { profile: e.profile } : {}),
    model: modelLabel(e.model),
    ...(e.model ? { modelId: e.model } : {}),
    ...(lastChat ? { lastChat } : {}),
    ...(profile?.description ? { description: profile.description } : {}),
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
  const engineName = computed(
    relay.status,
    (s) => s.result?.engine?.name ?? "",
  );
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
      engineName,
      company,
      folders,
      modelRowStore(),
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
    ],
    (
      employees,
      conversations,
      summaries,
      channels,
      askRows,
      _status,
      now,
      engine,
      [me, companyName],
      folderRows,
      modelRows,
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
        agents: employees.map((e) =>
          toAgent(
            e,
            engine || undefined,
            profiles.byProfile[e.profile],
            chats.get(e.id),
            weeks.get(e.id) ?? { finished: 0, failed: 0, stuck: 0 },
          ),
        ),
        connectors: [],
        projects: projectRows(projects),
        goals: v3Goals(goals),
        tickets: v3Tickets(tickets, now),
        threads: v3Threads(src),
        archivedThreads: v3ArchivedThreads(src),
        asks: v3Asks(src),
        updates: [],
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
        // Tickets are real records now (D-#776): Work, Goals and Inbox show.
        features: { tickets: true },
        ...settingsSlice,
      };
    },
  );
  return store;
}
