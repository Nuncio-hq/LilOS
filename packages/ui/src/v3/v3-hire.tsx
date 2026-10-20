import {
  CodeIcon,
  HeadsetIcon,
  PaletteIcon,
  SearchIcon,
  ShieldCheckIcon,
  TrendingUpIcon,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { AgentAvatar, Btn, CeoMark, Page, Title } from "./v3-bits";
import type { V3PageProps } from "./v3-types";

/* Hire: pick a role, check the three fields, done. With a CEO position the
   CEO writes the first instructions, so the form stays this short. The
   models on offer come from the app (`modelChoices`); a role only prefers
   one of them by place, and falls back to the first when the list is short. */

const choiceAt = (choices: string[], i: number): string | undefined =>
  choices[i] ?? choices[0];

const ROLES: { role: string; icon: ReactNode; does: string; model: number }[] =
  [
    {
      role: "Researcher",
      icon: <SearchIcon />,
      does: "Finds people, numbers and sources, and returns a sheet.",
      model: 1,
    },
    {
      role: "Engineer",
      icon: <CodeIcon />,
      does: "Writes and fixes code, and opens a PR for every ticket.",
      model: 0,
    },
    {
      role: "Designer",
      icon: <PaletteIcon />,
      does: "Makes screens and store assets, always two options.",
      model: 1,
    },
    {
      role: "Growth",
      icon: <TrendingUpIcon />,
      does: "Writes copy and runs growth tests with a number behind each claim.",
      model: 1,
    },
    {
      role: "QA",
      icon: <ShieldCheckIcon />,
      does: "Checks every result on a real device before it is called done.",
      model: 1,
    },
    {
      role: "Support",
      icon: <HeadsetIcon />,
      does: "Answers users and files what it learns as tickets.",
      model: 2,
    },
  ];

const FIELD = "text-[13px] text-muted-foreground";

export function V3Hire({ data, go, act }: V3PageProps) {
  const [picked, setPicked] = useState<number | null>(null);
  const [name, setName] = useState("");
  // Undefined follows the role's preferred model until you pick one.
  const [chosen, setChosen] = useState<string>();
  const hiring = useRef(false);
  const ceo = data.agents.find((a) => a.id === data.ceoId);
  const tpl = picked === null ? undefined : ROLES[picked];
  const choices = data.modelChoices;
  const model =
    chosen && choices.includes(chosen)
      ? chosen
      : (choiceAt(choices, tpl?.model ?? 1) ?? "");

  function pick(i: number) {
    setPicked(i);
    setChosen(undefined);
    // A name is only suggested while the field is still untouched.
    setName((n) =>
      n === "" || ROLES.some((r) => r.role === n) ? ROLES[i].role : n,
    );
  }

  // Hiring lands on the new agent, opened beside People. A failed hire has
  // already been explained by the app, so the form just stays as it is.
  function submit() {
    const trimmed = name.trim();
    if (!act.hire || !tpl || !trimmed || hiring.current) return;
    hiring.current = true;
    act
      .hire({ name: trimmed, role: tpl.role, model })
      .then((id) => {
        go({ page: "people" });
        go({ page: "agent", id });
      })
      .catch(() => {})
      .finally(() => {
        hiring.current = false;
      });
  }

  if (!act.hire) {
    return (
      <Page wide>
        <Title>Hire an agent</Title>
        <p className="text-[14.5px] text-muted-foreground">
          Hiring is not available while the engine cannot create agents.
        </p>
      </Page>
    );
  }

  return (
    <Page wide>
      <Title>Hire an agent</Title>
      <p className="text-[14.5px] text-muted-foreground">
        {ceo
          ? "Pick a role. The CEO writes the first instructions; you can edit them later."
          : "Pick a role; you can edit its instructions later."}
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
            {choiceAt(choices, r.model) && (
              <span className="mt-auto pt-1 text-[12.5px] text-muted-foreground/70">
                {choiceAt(choices, r.model)}
              </span>
            )}
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
          {/* The engine this company runs on, as it names itself: one today,
             so a fact, not a choice (no placeholder for engines to come). */}
          <div>
            <span className={FIELD}>Runs on</span>
            <div className="mt-1 text-[14px] text-foreground">
              {data.settings.engine.name}
            </div>
          </div>
          {choices.length > 0 && (
            <div>
              <span className={cn(FIELD, "block")}>Model</span>
              <div className="mt-1 inline-flex rounded-[7px] border border-[var(--v3-line)] p-0.5">
                {choices.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setChosen(m)}
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
          )}
          {ceo && (
            <div>
              <span className={FIELD}>Reports to</span>
              <div className="mt-1 flex items-center gap-2 text-[14px] text-foreground">
                <AgentAvatar data={data} agent={ceo} />
                {ceo.name}
                <CeoMark />
              </div>
            </div>
          )}
          <div className="pt-1">
            <Btn primary onClick={submit}>
              Hire
            </Btn>
          </div>
        </form>
      )}

      <p className="mt-6 text-[13px] text-muted-foreground/70">
        {!data.features.tickets
          ? "It starts idle until you message it."
          : ceo
            ? "It starts idle. The CEO gives it its first ticket."
            : "It starts idle until it gets its first ticket."}
      </p>
    </Page>
  );
}
