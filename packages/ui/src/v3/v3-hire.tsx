import {
  CodeIcon,
  HeadsetIcon,
  PaletteIcon,
  SearchIcon,
  ShieldCheckIcon,
  TrendingUpIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../lib/utils";
import { AgentAvatar, Btn, CeoMark, Page, Title } from "./v3-bits";
import { agentOf } from "./v3-model";
import type { V3PageProps } from "./v3-types";

/* Hire: pick a role, check the three fields, done. The CEO writes the first
   instructions, so the form stays this short. */

const MODELS = ["Opus 5.5 · High", "Sonnet 5 · Medium", "Haiku 5 · Fast"];

const ROLES: { role: string; icon: ReactNode; does: string; model: string }[] =
  [
    {
      role: "Researcher",
      icon: <SearchIcon />,
      does: "Finds people, numbers and sources, and returns a sheet.",
      model: MODELS[1],
    },
    {
      role: "Engineer",
      icon: <CodeIcon />,
      does: "Writes and fixes code, and opens a PR for every ticket.",
      model: MODELS[0],
    },
    {
      role: "Designer",
      icon: <PaletteIcon />,
      does: "Makes screens and store assets, always two options.",
      model: MODELS[1],
    },
    {
      role: "Growth",
      icon: <TrendingUpIcon />,
      does: "Writes copy and runs growth tests with a number behind each claim.",
      model: MODELS[1],
    },
    {
      role: "QA",
      icon: <ShieldCheckIcon />,
      does: "Checks every result on a real device before it is called done.",
      model: MODELS[1],
    },
    {
      role: "Support",
      icon: <HeadsetIcon />,
      does: "Answers users and files what it learns as tickets.",
      model: MODELS[2],
    },
  ];

const FIELD = "text-[13px] text-muted-foreground";

export function V3Hire({ data, go, act }: V3PageProps) {
  const [picked, setPicked] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [model, setModel] = useState(MODELS[1]);
  const ceo = agentOf(data, data.ceoId);
  const tpl = picked === null ? undefined : ROLES[picked];

  function pick(i: number) {
    setPicked(i);
    setModel(ROLES[i].model);
    // A name is only suggested while the field is still untouched.
    setName((n) =>
      n === "" || ROLES.some((r) => r.role === n) ? ROLES[i].role : n,
    );
  }

  // Hiring lands on the new agent, opened beside People.
  function submit() {
    const trimmed = name.trim();
    if (!tpl || !trimmed) return;
    const id = act.hire({ name: trimmed, role: tpl.role, model });
    go({ page: "people" });
    go({ page: "agent", id });
  }

  return (
    <Page wide>
      <Title>Hire an agent</Title>
      <p className="text-[14.5px] text-muted-foreground">
        Pick a role. The CEO writes the first instructions; you can edit them
        later.
      </p>

      <div className="mt-6 grid grid-cols-3 gap-3">
        {ROLES.map((r, i) => (
          <button
            key={r.role}
            type="button"
            onClick={() => pick(i)}
            className={cn(
              "flex flex-col items-start gap-1.5 rounded-lg border p-3.5 text-left transition-colors hover:bg-[var(--v3-hover)]",
              picked === i ? "border-foreground" : "border-[var(--v3-line)]",
            )}
          >
            <span className="text-muted-foreground [&_svg]:size-[18px]">
              {r.icon}
            </span>
            <span className="font-semibold text-[14.5px] text-foreground">
              {r.role}
            </span>
            <span className="text-[13px] text-muted-foreground leading-snug">
              {r.does}
            </span>
            <span className="mt-auto pt-1 text-[12.5px] text-muted-foreground/70">
              {r.model}
            </span>
          </button>
        ))}
      </div>

      {tpl && (
        <form
          className="mt-8 max-w-[520px] space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="block">
            <span className={FIELD}>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              className="mt-1 h-8 w-full rounded-[7px] border border-foreground/15 bg-background px-2.5 text-[14px] text-foreground outline-none focus:border-foreground/40"
            />
          </label>
          <div>
            <span className={FIELD}>Role</span>
            <div className="mt-1 text-[14px] text-foreground">{tpl.role}</div>
          </div>
          <div>
            <span className={FIELD}>Runs on</span>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="inline-flex h-[26px] items-center rounded-[7px] border border-foreground bg-[var(--v3-soft)] px-2.5 font-medium text-[13px] text-foreground">
                Hermes
              </span>
              <button
                type="button"
                disabled
                className="inline-flex h-[26px] cursor-not-allowed items-center rounded-[7px] border border-[var(--v3-line)] px-2.5 text-[13px] text-muted-foreground/60"
              >
                Claude Code
              </button>
              <span className="text-[12.5px] text-muted-foreground/70">
                Soon · through ACP
              </span>
            </div>
          </div>
          <div>
            <span className={FIELD}>Model</span>
            <div className="mt-1 inline-flex rounded-[7px] border border-[var(--v3-line)] p-0.5">
              {MODELS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setModel(m)}
                  className={cn(
                    "h-[26px] rounded-[5px] px-2.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground",
                    model === m &&
                      "bg-[var(--v3-soft)] font-medium text-foreground",
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className={FIELD}>Reports to</span>
            <div className="mt-1 flex items-center gap-2 text-[14px] text-foreground">
              <AgentAvatar data={data} agent={ceo} />
              {ceo.name}
              <CeoMark />
            </div>
          </div>
          <div className="pt-1">
            <Btn primary onClick={submit}>
              Hire
            </Btn>
          </div>
        </form>
      )}

      <p className="mt-6 text-[13px] text-muted-foreground/70">
        It starts idle. The CEO gives it its first ticket.
      </p>
    </Page>
  );
}
