import { agentNameOf, type V3Data, type V3DataActions } from "@lilos/ui"
import { ENGINE_PROFILES } from "../fake-v3"
import { MODEL_OPTIONS, modelIdOf } from "../fake-v3-models"
import { cancelTurn } from "./chat-sim"
import { type Engine, patchConnect } from "./context"

/* Settings → Engine lists LilOS's connection per engine profile: a new hire's
   profile joins it connected when you already approved, waiting otherwise. */
const withRow = (d: V3Data, profile: string, employee: string): V3Data =>
  patchConnect(d, (c) =>
    c.rows.some((r) => r.profile === profile)
      ? c
      : { ...c, rows: [...c.rows, { profile, employee, state: c.approved ? "connected" : "not-connected" }] },
  )

/* The team: hiring, the CEO position, what an agent is allowed to do, what it
   has learned, and the connectors it uses. */
export function peopleActions({ setData, getData, toast }: Engine): Pick<
  V3DataActions,
  | "acceptRule"
  | "dismissRule"
  | "hire"
  | "listProfiles"
  | "hireProfile"
  | "makeCeo"
  | "updateAgent"
  | "removeAgent"
  | "toggleConnector"
  | "addConnector"
  | "saveNote"
  | "setAgentSkill"
> {
  return {
    acceptRule: (agentId) => {
      setData((d) => ({
        ...d,
        agents: d.agents.map((a) =>
          a.id === agentId && a.suggestion
            ? {
                ...a,
                instructions: [...a.instructions, a.suggestion.text],
                suggestion: undefined,
              }
            : a,
        ),
      }));
      toast("Rule added to the instructions");
    },
    dismissRule: (agentId) => {
      setData((d) => ({
        ...d,
        agents: d.agents.map((a) =>
          a.id === agentId ? { ...a, suggestion: undefined } : a,
        ),
      }));
    },
    hire: ({ name, role, model }) => {
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "agent";
      setData((d) => ({
        ...d,
        agents: [
          ...d.agents,
          {
            id,
            name,
            tone: (["b", "r", "m", "s", "d", "c"] as const)[
              d.agents.length % 6
            ],
            role,
            reportsTo: d.ceoId,
            hired: "today",
            runtime: `Hermes · profile ${id}`,
            profile: id,
            model,
            modelId: modelIdOf(MODEL_OPTIONS, model),
            schedule: "When given a ticket",
            skills: [],
            spend: { used: 0, cap: 10, period: "week" },
            instructions: [
              `You are ${name}, the company’s ${role.toLowerCase()}. The CEO gives you tickets; finish them and report back in one short update.`,
            ],
            // Empty, not absent: the page can add a file (D-#19).
            notes: [],
            week: { done: 0, typical: "—", stuck: 0, handed: 0 },
            next: "Waiting for the CEO to give a first ticket",
          },
        ],
      }));
      setData((d) => withRow(d, id, name))
      toast(`${name} hired`)
      return Promise.resolve(id)
    },
    listProfiles: () => Promise.resolve(ENGINE_PROFILES),
    // The agent runs on the profile as it is: the profile's own model and
    // persona come with it, nothing is written to the profile.
    hireProfile: ({ profile, name, role }) => {
      const p = ENGINE_PROFILES.find((x) => x.id === profile);
      if (!p) return Promise.reject(new Error("That profile is not on the engine"));
      const id = `${profile}-${getData().agents.length}`;
      setData((d) => ({
        ...d,
        agents: [
          ...d.agents,
          {
            id,
            name,
            tone: (["b", "r", "m", "s", "d", "c"] as const)[
              d.agents.length % 6
            ],
            role,
            reportsTo: d.ceoId,
            hired: "today",
            runtime: `Hermes · profile ${profile}`,
            profile,
            model: p.model ?? d.modelChoices[0],
            modelId: modelIdOf(MODEL_OPTIONS, p.model ?? d.modelChoices[0]),
            description: p.description,
            schedule: "When given a ticket",
            skills: [],
            spend: { used: 0, cap: 10, period: "week" },
            instructions: p.soul ? [p.soul] : [],
            notes: [],
            week: { done: 0, typical: "—", stuck: 0, handed: 0 },
            next: "Waiting for the CEO to give a first ticket",
          },
        ],
      }));
      setData((d) => withRow(d, profile, name))
      toast(`${name} hired on the ${p.name} profile`)
      return Promise.resolve(id)
    },
    makeCeo: (agentId) => {
      setData((d) => {
        if (d.ceoId === agentId) return d;
        // The position moves; the org follows it: the new CEO reports to
        // you, everyone else (the old CEO included) reports to the new one.
        return {
          ...d,
          ceoId: agentId,
          agents: d.agents.map((a) => ({
            ...a,
            reportsTo: a.id === agentId ? undefined : agentId,
          })),
        };
      });
      toast(`${agentNameOf(getData(), agentId)} is now the CEO`);
    },
    updateAgent: (id, patch) => {
      setData((d) => ({
        ...d,
        agents: d.agents.map((a) =>
          a.id !== id
            ? a
            : {
                ...a,
                ...(patch.name !== undefined && { name: patch.name }),
                ...(patch.role !== undefined && { role: patch.role }),
                ...(patch.description !== undefined && {
                  description: patch.description || undefined,
                }),
                ...(patch.model !== undefined && { model: patch.model, modelId: modelIdOf(MODEL_OPTIONS, patch.model) }),
                ...(patch.muted !== undefined && { muted: patch.muted }),
                ...(patch.instructions !== undefined && {
                  instructions: patch.instructions
                    .split(/\n{2,}/)
                    .map((p) => p.trim())
                    .filter(Boolean),
                }),
              },
        ),
      }));
      // Notifications flip silently: the switch is the confirmation.
      if (patch.muted === undefined) toast(`${patch.name ?? agentNameOf(getData(), id)} saved`);
      return Promise.resolve(undefined);
    },
    removeAgent: (id) => {
      const gone = agentNameOf(getData(), id);
      const profile = getData().agents.find((a) => a.id === id)?.profile;
      const threadIds = new Set(getData().threads.filter((t) => t.agentId === id).map((t) => t.id));
      for (const t of threadIds) cancelTurn(t);
      // The real relay deletes the agent's threads and scheduled jobs with it;
      // tickets it owned stay, and read "Former agent".
      setData((d) => ({
        ...d,
        agents: d.agents.filter((a) => a.id !== id).map((a) => (a.reportsTo === id ? { ...a, reportsTo: d.ceoId } : a)),
        threads: d.threads.filter((t) => !threadIds.has(t.id)),
        schedules: d.schedules.filter((s) => s.agentId !== id),
        asks: d.asks.filter((a) => a.threadId === undefined || !threadIds.has(a.threadId)),
        connectors: d.connectors.map((c) => (c.agents.includes(id) ? { ...c, agents: c.agents.filter((a) => a !== id) } : c)),
        browser: { ...d.browser, tabs: d.browser.tabs.filter((t) => t.by !== id) },
      }));
      // The engine's profile stays (D-#29): its row stays too, with nobody on it.
      setData((d) => patchConnect(d, (c) => ({ ...c, rows: c.rows.map((r) => (r.profile === profile ? { ...r, employee: undefined } : r)) })));
      toast(`${gone} removed from the company`);
      return Promise.resolve();
    },
    saveNote: (agentId, note) => {
      const name = note.name.trim();
      if (!name || /[/\\]/.test(name)) return;
      const notes = getData().agents.find((a) => a.id === agentId)?.notes ?? [];
      if (notes.some((n) => n.name === name && n.id !== note.id)) {
        toast("A note already has that name");
        return;
      }
      const base =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "note";
      setData((d) => ({
        ...d,
        agents: d.agents.map((a) => {
          if (a.id !== agentId) return a;
          const files = a.notes ?? [];
          if (note.id && files.some((n) => n.id === note.id)) {
            return {
              ...a,
              notes: files.map((n) =>
                n.id === note.id
                  ? { ...n, name, text: note.text, updated: "just now" }
                  : n,
              ),
            };
          }
          const taken = new Set(files.map((n) => n.id));
          let id = base;
          for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
          return {
            ...a,
            notes: [...files, { id, name, text: note.text, updated: "just now" }],
          };
        }),
      }));
      // The row's "just now" is the confirmation. A toast would cover the
      // list it just updated.
    },
    setAgentSkill: (agentId, skillId, attached) => {
      setData((d) => ({
        ...d,
        agents: d.agents.map((a) => {
          if (a.id !== agentId) return a;
          const skills = a.skills ?? [];
          const has = skills.includes(skillId);
          if (attached === has) return a;
          return {
            ...a,
            skills: attached
              ? [...skills, skillId]
              : skills.filter((s) => s !== skillId),
          };
        }),
      }));
    },
    toggleConnector: (connectorId, agentId) => {
      setData((d) => ({
        ...d,
        connectors: d.connectors.map((c) =>
          c.id !== connectorId
            ? c
            : {
                ...c,
                agents: c.agents.includes(agentId)
                  ? c.agents.filter((a) => a !== agentId)
                  : [...c.agents, agentId],
              },
        ),
      }));
    },
    addConnector: ({ label, kind, command }) => {
      const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "connector";
      setData((d) => ({
        ...d,
        connectors: [
          ...d.connectors,
          {
            id,
            label,
            kind,
            command,
            about:
              kind === "mcp"
                ? "An MCP server you added."
                : "A command you added.",
            // A new connector is found but not yet tried; its own login (if
            // any) happens the first time an agent uses it.
            state: "ready",
            look: { mark: label.slice(0, 1).toUpperCase(), color: "#57534e" },
            agents: [],
          },
        ],
      }));
      toast(`${label} added · turn it on for the agents that need it`);
    },
  }
}
