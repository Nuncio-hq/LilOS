import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AgentAvatar, Avatar, Btn, TicketId } from "./v3-bits";
import { agentOf, FORMER_AGENT, goalOf } from "./v3-model";
import type { V3Data, V3Draft } from "./v3-types";

/* ⌘K's draft plan: what the CEO would start, with the one button that makes
   it real. */

type Plan = Extract<V3Draft, { kind: "plan" }>;

/** The bar under a ⌘K answer or plan: its buttons, the main one last. */
export function Footer({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-[var(--v3-line)] border-t bg-[var(--v3-soft)] px-[18px] py-3">
      {children}
    </div>
  );
}

export function PlanView({
  plan,
  data,
  onEdit,
  onAnswer,
  onStart,
}: {
  plan: Plan;
  data: V3Data;
  onEdit: () => void;
  onAnswer: () => void;
  onStart: () => void;
}) {
  const owners = new Set(plan.tickets.map((t) => t.owner)).size;
  const goal = plan.goalId ? goalOf(data, plan.goalId) : undefined;
  return (
    <>
      <div className="px-[18px] pt-3.5 pb-1.5">
        <div className="flex items-center gap-2 font-medium text-[12px] text-muted-foreground/70">
          <Avatar name="CEO" tone="c" size={18} />
          CEO · draft plan{goal ? ` · goal ${goal.title}` : ""}
        </div>
        <p className="mt-2 mb-1 text-[14.5px] leading-relaxed">{plan.lead}</p>
        <div className="mt-2 mb-1.5 flex flex-wrap gap-x-[18px] text-[13px] text-muted-foreground">
          <span>
            <b className="font-semibold text-foreground">
              {plan.tickets.length}
            </b>{" "}
            tickets
          </span>
          <span>
            <b className="font-semibold text-foreground">{owners}</b> agents
          </span>
          <span>
            about <b className="font-semibold text-foreground">{plan.hours}h</b>{" "}
            of agent time
          </span>
          <span>
            about <b className="font-semibold text-foreground">${plan.cost}</b>{" "}
            in model cost
          </span>
        </div>
        <div className="mt-1">
          {plan.tickets.map((t) => {
            const a = agentOf(data, t.owner);
            return (
              <div
                key={t.id}
                className="flex min-h-10 items-center gap-2 border-[var(--v3-line)] border-b text-[13.5px] last:border-b-0"
              >
                <TicketId id={t.id} className="w-12 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {t.title}
                  {t.asksYou && (
                    <span className="ml-2 rounded-full bg-orange-50 px-2 py-px font-medium text-[12px] text-orange-700 dark:bg-orange-400/14 dark:text-orange-300">
                      asks you first
                    </span>
                  )}
                </span>
                <span className="flex w-[108px] shrink-0 items-center gap-2 font-medium">
                  <AgentAvatar data={data} agent={a} />
                  {a?.name ?? FORMER_AGENT}
                </span>
                <span className="w-[96px] shrink-0 text-[12.5px] text-muted-foreground/70">
                  {t.after ? `after ${t.after}` : "starts now"}
                </span>
                <span className="w-9 shrink-0 text-right text-muted-foreground">
                  {t.est}
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2 pt-2.5 pb-1 text-[13px] text-muted-foreground">
          <CircleAlertIcon className="size-3.5" />
          I’ll ask you before anything goes public or costs money. Everything
          else I decide.
        </div>
      </div>
      <Footer>
        <Btn onClick={onEdit}>Edit request</Btn>
        <Btn onClick={onAnswer}>Just answer, no tickets</Btn>
        <span className="ml-auto" />
        <Btn primary onClick={onStart}>
          Start
          <span className="ml-1 rounded border border-background/30 px-1 text-[11px] text-background/75">
            ⌘↵
          </span>
        </Btn>
      </Footer>
    </>
  );
}
