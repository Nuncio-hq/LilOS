import { ShieldAlertIcon, SparklesIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { BotAvatar, PROVIDER, ProviderChip } from "./company-bits";
import type {
  Bot,
  BotAsk,
  CompanyProject,
  CompanyTicket,
} from "./company-types";

const RISK: Record<NonNullable<BotAsk["risk"]>, string> = {
  "spends-money": "Spends money",
  "sends-outside": "Sends outside the company",
  "dangerous-command": "Dangerous command",
};

/* Right column: what needs the owner (risky asks only), what the CEO answered
   for him, and the bot teams per project with each provider's strength. */
export function WorkforcePanel({
  projects,
  bots,
  asks,
  tickets,
  onApprove,
  onDeny,
  onOpenTicket,
}: {
  projects: CompanyProject[];
  bots: Bot[];
  asks: BotAsk[];
  tickets: CompanyTicket[];
  onApprove?: (askId: string) => void;
  onDeny?: (askId: string) => void;
  onOpenTicket: (id: string) => void;
}) {
  const bot = (id: string) => bots.find((b) => b.id === id);
  const mine = asks.filter((a) => a.risk);
  const ceoHandled = asks.filter((a) => !a.risk && a.ceoAnswer);
  const teams = [
    ...projects.map((p) => ({
      title: p.name,
      bots: bots.filter((b) => b.projectId === p.id),
    })),
    { title: "Shared", bots: bots.filter((b) => !b.projectId) },
  ].filter((t) => t.bots.length > 0);

  return (
    <aside
      aria-label="Workforce"
      className="lilos-glass flex min-h-0 min-w-0 flex-col"
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <section>
          <h2 className="mb-2 flex items-center gap-2 font-semibold text-[13px]">
            <ShieldAlertIcon className="size-4 text-amber-600" />
            Needs you
            <span className="rounded-full bg-amber-500/15 px-1.5 text-[11px] text-amber-800 dark:text-amber-300">
              {mine.length}
            </span>
          </h2>
          {mine.length === 0 && (
            <p className="text-muted-foreground text-xs">
              Nothing risky is waiting. The CEO handles routine questions.
            </p>
          )}
          <div className="space-y-2">
            {mine.map((a) => {
              const b = bot(a.bot);
              return (
                <div
                  key={a.id}
                  className="rounded-xl border border-amber-500/40 bg-amber-50/60 p-3 dark:bg-amber-500/5"
                >
                  <div className="flex items-center gap-2 text-[11.5px]">
                    {b && <BotAvatar bot={b} size={20} />}
                    <span className="font-medium">{b?.name}</span>
                    <button
                      onClick={() => onOpenTicket(a.ticketId)}
                      className="font-mono text-muted-foreground hover:underline"
                    >
                      {a.ticketId}
                    </button>
                    <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 text-[10.5px] text-amber-800 dark:text-amber-300">
                      {a.risk && RISK[a.risk]}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[13px]">{a.text}</p>
                  {(onApprove || onDeny) && (
                    <div className="mt-2 flex gap-2">
                      {onApprove && (
                        <Button size="sm" onClick={() => onApprove(a.id)}>
                          Approve
                        </Button>
                      )}
                      {onDeny && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onDeny(a.id)}
                        >
                          Deny
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {ceoHandled.length > 0 && (
          <section>
            <h2 className="mb-2 font-semibold text-[13px]">The CEO answered</h2>
            <div className="space-y-2">
              {ceoHandled.map((a) => {
                const b = bot(a.bot);
                const t = tickets.find((x) => x.id === a.ticketId);
                return (
                  <div
                    key={a.id}
                    className="rounded-xl border bg-background p-3 text-[12.5px]"
                  >
                    <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                      {b && <BotAvatar bot={b} size={18} />}
                      {b?.name} asked on{" "}
                      <button
                        onClick={() => onOpenTicket(a.ticketId)}
                        className="font-mono hover:underline"
                        title={t?.title}
                      >
                        {a.ticketId}
                      </button>
                    </div>
                    <p className="mt-1">{a.text}</p>
                    <p className="mt-1 text-muted-foreground">
                      <span className="font-medium text-foreground">CEO:</span>{" "}
                      {a.ceoAnswer}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section>
          <h2 className="mb-2 flex items-center gap-2 font-semibold text-[13px]">
            <SparklesIcon className="size-4 text-tint-text" />
            Always-on bots
          </h2>
          <div className="space-y-3">
            {teams.map((team) => (
              <div key={team.title}>
                <div className="mb-1 px-1 font-semibold text-[11px] text-muted-foreground">
                  {team.title}
                </div>
                <div className="space-y-1">
                  {team.bots.map((b) => (
                    <div
                      key={b.id}
                      className="flex items-start gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-accent"
                    >
                      <BotAvatar bot={b} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium text-[13px]">
                            {b.name}
                          </span>
                          <ProviderChip provider={b.provider} />
                        </div>
                        <div className="truncate text-[11.5px] text-muted-foreground">
                          {b.role} · {b.strength}
                        </div>
                        <div
                          className={cn(
                            "truncate text-[11.5px]",
                            b.state === "working"
                              ? "text-work"
                              : "text-muted-foreground",
                          )}
                        >
                          {b.now}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Bots run at their provider (
            {Object.values(PROVIDER)
              .map((p) => `${p.label} by ${p.maker}`)
              .join(", ")}
            ) and keep working when LilOS is closed.
          </p>
        </section>
      </div>
    </aside>
  );
}
