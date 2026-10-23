import { HIRE_TEMPLATES, type V3Agent, type V3Data } from "@lilos/ui/v3-data";
import { MODEL_OPTIONS, modelIdOf } from "../../../../web/src/fake-v3-models";
import { $data } from "./state";

const TONES = ["b", "r", "m", "s", "d", "c"] as const;

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "agent";

/* Settings → Engine lists LilOS's connection per engine profile: a new
   hire's profile joins it connected when you already approved, waiting
   otherwise. */
function withConnectRow(d: V3Data, profile: string, employee: string): V3Data {
  const connect = d.settings.connect;
  if (!connect || connect.rows.some((r) => r.profile === profile)) return d;
  const row = {
    profile,
    employee,
    state: connect.approved
      ? ("connected" as const)
      : ("not-connected" as const),
  };
  return {
    ...d,
    settings: {
      ...d.settings,
      connect: { ...connect, rows: [...connect.rows, row] },
    },
  };
}

/** Hires the template with this `role` as a new agent reporting to the CEO;
    returns its id. A second Designer is "Designer 2". */
export function hire(role: string): string {
  const template = HIRE_TEMPLATES.find((t) => t.role === role);
  if (!template) throw new Error(`No hire template for the role "${role}"`);
  const d = $data.get();
  const names = new Set(d.agents.map((a) => a.name.toLowerCase()));
  const ids = new Set(d.agents.map((a) => a.id));
  let name = role;
  for (let n = 2; names.has(name.toLowerCase()) || ids.has(slug(name)); n++)
    name = `${role} ${n}`;
  const id = slug(name);
  const model = d.modelChoices[template.modelAt] ?? d.modelChoices[0] ?? "";
  const agent: V3Agent = {
    id,
    name,
    tone: TONES[d.agents.length % TONES.length],
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
    instructions: [template.instructions],
    // Empty, not absent: the page can add a file.
    notes: [],
    next: "Waiting for the CEO to give a first ticket",
  };
  $data.set(withConnectRow({ ...d, agents: [...d.agents, agent] }, id, name));
  return id;
}
