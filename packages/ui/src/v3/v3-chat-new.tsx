import { type ReactNode, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { AgentAvatar, Page, ProjectMark, Title } from "./v3-bits";
import { Composer } from "./v3-composer";
import type { V3PageProps } from "./v3-types";

/* A new chat: pick who, where and on what, then just write. It is a thread
   with no ticket; "Make it a ticket" turns it into work later. */

const MODELS = ["Opus 5.5 · High", "Sonnet 5 · Medium", "Haiku 5 · Fast"];

const SUGGESTIONS = [
  "Why is ac-544 flaky?",
  "Summarise yesterday's PRs",
  "Draft release notes for 0.9",
];

/** One selectable choice in a row of choices. */
function Choice({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "inline-flex h-8 min-w-0 items-center gap-2 rounded-lg border px-2.5 text-[13.5px] transition-colors",
        on
          ? "border-foreground bg-[var(--v3-soft)] font-medium text-foreground"
          : "border-[var(--v3-line)] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-5">
      <div className="mb-2 text-[13px] text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function V3ChatNew({
  data,
  act,
  agentId,
}: V3PageProps & { agentId?: string }) {
  const first = (id: string) => data.agents.find((a) => a.id === id);
  const [pickedAgent, setAgent] = useState(
    first(agentId ?? "")?.id ?? first("builder")?.id ?? data.agents[0].id,
  );
  const agent = first(pickedAgent) ?? data.agents[0];
  const [projectId, setProject] = useState(data.projects[0]?.id ?? "");
  const project = data.projects.find((p) => p.id === projectId);
  // The model follows the agent until you choose one yourself.
  const [chosen, setChosen] = useState<string>();
  // An outside worker has no model of its own: no row, and none sent.
  const outside = agent.kind === "outside";
  const model = outside ? "" : (chosen ?? agent.model);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  return (
    <Page>
      <Title>New chat</Title>
      <p className="-mt-1 text-[15px] text-muted-foreground">
        Talk to one agent directly. It works in the project’s folder; turn it
        into a ticket any time.
      </p>

      <Row label="Agent">
        {data.agents.map((a) => (
          <Choice
            key={a.id}
            on={a.id === agent.id}
            onClick={() => setAgent(a.id)}
          >
            <AgentAvatar data={data} agent={a} size={18} />
            <span className="truncate">{a.name}</span>
            <span className="truncate font-normal text-[12.5px] text-muted-foreground/70">
              {a.role}
            </span>
          </Choice>
        ))}
      </Row>

      <Row label="Project">
        {data.projects.map((p) => (
          <Choice
            key={p.id}
            on={p.id === projectId}
            onClick={() => setProject(p.id)}
          >
            <ProjectMark name={p.name} tone={p.tone} />
            <span className="truncate">{p.name}</span>
            <span className="truncate font-mono font-normal text-[12px] text-muted-foreground/70">
              {p.folder}
            </span>
          </Choice>
        ))}
      </Row>

      {!outside && (
        <Row label="Model">
          {MODELS.map((m) => (
            <Choice key={m} on={m === model} onClick={() => setChosen(m)}>
              {m}
            </Choice>
          ))}
        </Row>
      )}

      <div className="mt-8 flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setDraft(s);
              input.current?.focus();
            }}
            className="h-7 rounded-full border border-[var(--v3-line)] px-3 text-[13px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
          >
            {s}
          </button>
        ))}
      </div>

      <div className="mt-3">
        <Composer
          data={data}
          agent={agent}
          model={model}
          folder={project?.folder ?? "~"}
          value={draft}
          onChange={setDraft}
          inputRef={input}
          onSend={(text) =>
            act.startChat({
              agentId: agent.id,
              projectId,
              model,
              text,
            })
          }
        />
      </div>
    </Page>
  );
}
