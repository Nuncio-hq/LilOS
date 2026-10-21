import { cn } from "../lib/utils";
import { span } from "./v3-bits";
import { AgentAvatar, CeoMark, DOT } from "./v3-marks";
import type { V3Status } from "./v3-types";
import type { WorkViewProps } from "./v3-work-views";

/* Today as one strip, 08:00 to 18:00: a row per agent, a bar per thread.
   The "now" line is the clock on this machine, not a fixed mock time. */

const DAY_START = 8 * 60;
const DAY_END = 18 * 60;
/** A planned ticket has no estimate yet; draw it an hour long. */
const PLANNED_LEN = 60;
const LANE = 28;
const LABEL_W = 116;

const TIME = /^(\d{1,2}):(\d{2})$/;
const toMin = (hhmm: string) => {
  const m = TIME.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const pct = (m: number) =>
  ((Math.min(DAY_END, Math.max(DAY_START, m)) - DAY_START) /
    (DAY_END - DAY_START)) *
  100;

type Bar = {
  key: string;
  start: number;
  end: number;
  ticketId?: string;
  label: string;
  status: V3Status;
  planned: boolean;
  open: () => void;
  title: string;
};

/** Greedy lanes: a bar drops to the next lane if it overlaps the one above. */
function lanes(bars: Bar[]) {
  const ends: number[] = [];
  return [...bars]
    .sort((a, b) => a.start - b.start)
    .map((b) => {
      let lane = ends.findIndex((e) => e <= b.start);
      if (lane < 0) lane = ends.length;
      ends[lane] = b.end;
      return { bar: b, lane };
    });
}

const HOURS = Array.from(
  { length: DAY_END / 60 - DAY_START / 60 + 1 },
  (_, i) => DAY_START / 60 + i,
);

export function TimelineView({ data, go, tickets }: WorkViewProps) {
  const clock = new Date();
  const nowMin = clock.getHours() * 60 + clock.getMinutes();
  const nowLabel = `${String(clock.getHours()).padStart(2, "0")}:${String(clock.getMinutes()).padStart(2, "0")}`;
  const visible = new Set(tickets.map((t) => t.id));
  const barsOf = (agentId: string): Bar[] => [
    ...data.threads
      .filter(
        (t) =>
          t.agentId === agentId &&
          (t.ticketId === undefined || visible.has(t.ticketId)),
      )
      .flatMap((t) => {
        const start = toMin(t.startedAt);
        if (start === null) return [];
        return [
          {
            key: t.id,
            start,
            end: start + Math.max(t.minutes, 1),
            ticketId: t.ticketId,
            label: t.ticketId ? t.title : `Chat · ${t.title}`,
            status: t.status,
            planned: false,
            open: () => go({ page: "thread", id: t.id }),
            title: `${t.ticketId ?? "Chat"} · ${t.title} · ${span(t.minutes)}`,
          },
        ];
      }),
    ...tickets
      .filter((t) => t.owner === agentId && t.status === "planned")
      .flatMap((t) => {
        const start = t.startsAt ? toMin(t.startsAt) : null;
        if (start === null) return [];
        return [
          {
            key: t.id,
            start,
            end: start + PLANNED_LEN,
            ticketId: t.id,
            label: t.title,
            status: "planned" as const,
            planned: true,
            open: () => go({ page: "ticket", id: t.id }),
            title: `${t.id} · ${t.title} · starts ${t.startsAt}`,
          },
        ];
      }),
  ];

  // Planned tickets with no clock time ("after HB-12", "Thu") sit below the strip.
  const later = tickets.filter(
    (t) =>
      t.status === "planned" && !(t.startsAt && toMin(t.startsAt) !== null),
  );

  return (
    <div className="mt-6">
      <div className="relative">
        {/* Hour lines and the now line sit behind every bar. */}
        <div
          className="pointer-events-none absolute inset-y-0 right-0"
          style={{ left: LABEL_W }}
        >
          {HOURS.map((h) => (
            <span
              key={h}
              className="absolute inset-y-0 w-px bg-[var(--v3-line)]"
              style={{ left: `${pct(h * 60)}%` }}
            />
          ))}
          <span
            className="absolute inset-y-0 w-px bg-foreground/60"
            style={{ left: `${pct(nowMin)}%` }}
          />
        </div>

        <div className="relative flex h-6 items-center text-[11.5px] text-muted-foreground/70">
          <div style={{ width: LABEL_W }} className="shrink-0" />
          <div className="relative h-full flex-1">
            {HOURS.map((h) => (
              <span
                key={h}
                className="absolute top-0 -translate-x-1/2"
                style={{ left: `${pct(h * 60)}%` }}
              >
                {String(h).padStart(2, "0")}
              </span>
            ))}
            <span
              className="absolute -top-0.5 z-10 -translate-x-1/2 rounded bg-foreground px-1.5 text-[11px] text-background"
              style={{ left: `${pct(nowMin)}%` }}
            >
              {nowLabel}
            </span>
          </div>
        </div>

        {data.agents.map((a) => {
          const placed = lanes(barsOf(a.id));
          const count = Math.max(1, ...placed.map((p) => p.lane + 1));
          return (
            <div
              key={a.id}
              className="relative flex border-[var(--v3-line)] border-t"
              style={{ minHeight: count * LANE + 12 }}
            >
              <div
                style={{ width: LABEL_W }}
                className="flex shrink-0 items-start gap-2 pt-[9px] text-[13.5px] font-medium"
              >
                <AgentAvatar data={data} agent={a} />
                {a.name}
                {a.id === data.ceoId && <CeoMark />}
              </div>
              <div className="relative flex-1">
                {placed.map(({ bar, lane }) => (
                  <button
                    type="button"
                    key={bar.key}
                    title={bar.title}
                    onClick={bar.open}
                    className={cn(
                      "absolute h-6 min-w-1.5 overflow-hidden rounded-md text-left text-[12px] transition-[filter] hover:brightness-95 dark:hover:brightness-125",
                      bar.planned &&
                        "border border-foreground/30 border-dashed",
                    )}
                    style={{
                      top: 6 + lane * LANE,
                      left: `${pct(bar.start)}%`,
                      width: `${Math.max(pct(bar.end) - pct(bar.start), 0.4)}%`,
                    }}
                  >
                    {!bar.planned && (
                      <>
                        <span
                          className={cn(
                            "absolute inset-0 opacity-20",
                            DOT[bar.status],
                          )}
                        />
                        <span
                          className={cn(
                            "absolute inset-y-0 left-0 w-[3px]",
                            DOT[bar.status],
                          )}
                        />
                      </>
                    )}
                    <span className="relative block truncate px-2 leading-6 text-foreground">
                      {bar.ticketId && (
                        <>
                          <span className="text-muted-foreground">
                            {bar.ticketId}
                          </span>{" "}
                        </>
                      )}
                      {bar.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        <div className="border-[var(--v3-line)] border-t" />
      </div>

      {later.length > 0 && (
        <p className="mt-4 text-[13px] text-muted-foreground">
          Later:{" "}
          {later.map((t, i) => (
            <span key={t.id}>
              {i > 0 && " · "}
              <button
                type="button"
                onClick={() => go({ page: "ticket", id: t.id })}
                className="hover:text-foreground"
              >
                {t.id} {t.title}
              </button>
              <span className="text-muted-foreground/70"> {t.startsAt}</span>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
