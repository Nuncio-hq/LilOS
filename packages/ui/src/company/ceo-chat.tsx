import { ArrowUpIcon, CrownIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { CeoInfo, CeoTurn, CompanyTicket } from "./company-types";

/* The owner's one conversation: the CEO. He hands off a goal; the CEO answers
   with what it did (tickets created, bots picked). No per-ticket approval —
   the CEO acts on its own (#746). */
export function CeoChat({
  ceo,
  turns,
  tickets,
  onSend,
  onOpenTicket,
}: {
  ceo: CeoInfo;
  turns: CeoTurn[];
  tickets: CompanyTicket[];
  onSend?: (text: string) => void;
  onOpenTicket?: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const send = () => {
    const text = draft.trim();
    if (!text || !onSend) return;
    onSend(text);
    setDraft("");
  };
  return (
    <section
      aria-label="CEO"
      className="lilos-glass flex min-h-0 min-w-0 flex-col"
    >
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-gradient-to-b from-amber-400 to-orange-600 text-white shadow-sm">
          <CrownIcon className="size-4.5" />
        </span>
        <div className="min-w-0">
          <div className="font-semibold">{ceo.name}</div>
          <div className="truncate text-muted-foreground text-xs">
            {ceo.runtime} · {ceo.model} ·{" "}
            <span className={cn(ceo.state === "working" && "text-work")}>
              {ceo.now}
            </span>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {turns.map((t) => (
          <div
            key={t.id}
            className={cn("flex", t.from === "oscar" && "justify-end")}
          >
            <div
              className={cn(
                "max-w-[92%] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed",
                t.from === "oscar"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/70",
              )}
            >
              <p className="whitespace-pre-wrap">{t.text}</p>
              {t.tickets && t.tickets.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {t.tickets.map((id) => {
                    const k = tickets.find((x) => x.id === id);
                    return (
                      <button
                        key={id}
                        onClick={() => onOpenTicket?.(id)}
                        className="rounded-md bg-background/80 px-2 py-0.5 font-mono text-[11px] text-foreground hover:bg-background"
                        title={k?.title}
                      >
                        {id}
                      </button>
                    );
                  })}
                </div>
              )}
              <div
                className={cn(
                  "mt-1 text-[10.5px]",
                  t.from === "oscar"
                    ? "text-primary-foreground/70"
                    : "text-muted-foreground",
                )}
              >
                {t.time}
              </div>
            </div>
          </div>
        ))}
      </div>

      {onSend && (
        <div className="shrink-0 border-t p-3">
          <div className="flex items-end gap-2 rounded-xl border bg-background px-3 py-2">
            <textarea
              aria-label="Message the CEO"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="Tell the CEO what you want. It plans, hands work to the bots and reports back."
              className="min-h-10 flex-1 resize-none bg-transparent text-[13.5px] outline-none placeholder:text-muted-foreground"
            />
            <Button
              size="icon-sm"
              onClick={send}
              disabled={!draft.trim()}
              aria-label="Send to the CEO"
            >
              <ArrowUpIcon />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
