import { threadStatus } from "@lilos/client-runtime";
import type { Employee } from "@lilos/contracts/app";
import { folderLabel, type V3Agent, type V3Data, type V3Tone } from "@lilos/ui";
import { atom, computed, onMount, type ReadableAtom } from "nanostores";
import { folders } from "../lib/folders";
import { currentCompany, currentName, osFullName, profile } from "../lib/me";
import { asks, relay, sessionModels, sessionSignals } from "../lib/runtime";
import { browserTabs } from "./browser";
import { modelLabel, modelRowStore } from "./models";
import { v3SettingsSlice } from "./settings-data";
import { v3Asks, v3Threads } from "./threads";

/* The company as the relay knows it, in the shape the v3 pages read. A
   computed store: pages re-render when the company changes, not on every
   streamed word (see `statusKey`). What the relay cannot tell stays absent
   (no projects, tickets, goals, updates, spend, skills, memory, CEO) and the
   pages hide those parts. */

/* Minute clock for "minutes running": one timer, only while something reads. */
const minute = atom(Date.now());
onMount(minute, () => {
  const t = setInterval(() => minute.set(Date.now()), 60_000);
  return () => clearInterval(t);
});

const TONES: V3Tone[] = ["c", "b", "r", "m", "s", "d"];

/** Employees have no colour of their own: a stable one from the name, so a
    person looks the same on every screen (31-polynomial hash). */
function toneOf(name: string): V3Tone {
  let x = 0;
  for (const ch of name.toLowerCase())
    x = (Math.imul(x, 31) + ch.charCodeAt(0)) >>> 0;
  return TONES[x % TONES.length];
}

function toAgent(e: Employee, runtime: string | undefined): V3Agent {
  return {
    id: e.id,
    name: e.name,
    tone: toneOf(e.name),
    role: e.role,
    hired: new Date(e.createdAt).toLocaleDateString([], {
      day: "numeric",
      month: "short",
    }),
    ...(runtime ? { runtime } : {}),
    model: modelLabel(e.model),
    instructions: e.instructions
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean),
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
      browserTabs,
      v3SettingsSlice,
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
      tabs,
      settingsSlice,
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
      return {
        company: companyName,
        me,
        today: todayText(now),
        agents: employees.map((e) => toAgent(e, engine || undefined)),
        connectors: [],
        projects: [],
        goals: [],
        tickets: [],
        threads: v3Threads(src),
        asks: v3Asks(src),
        updates: [],
        browser: { tabs, bookmarks: [] },
        modelChoices: modelRows.map((r) => r.label),
        ...(reachable.length
          ? {
              folders: reachable.map((f) => ({
                path: f.path,
                label: folderLabel(f, folderRows),
              })),
            }
          : {}),
        // Work, Goals and Inbox wait for tickets (M2).
        features: { tickets: false },
        ...settingsSlice,
      };
    },
  );
  return store;
}
