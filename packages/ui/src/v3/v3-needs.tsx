import { type ReactNode, useEffect, useMemo, useState } from "react";
import { foreignOverlayOpen } from "../chat/ui-layers";
import { ago, Btn, Page, relativeTime, Section, Title } from "./v3-bits";
import { CeoMark, INK, StatusDot } from "./v3-marks";
import {
  agentNameOf,
  agentOf,
  askTag,
  FORMER_AGENT,
  resultsToLookAt,
  threadsOf,
} from "./v3-model";
import { CHIP, OpenAsk } from "./v3-needs-ask";
import { RowButton } from "./v3-open-record";
import type { V3PageProps } from "./v3-page-types";

/* Needs you: the one place for everything waiting on the chairman. The
   oldest ask is open with its four answers (ask, why, yes, no); every ask
   also carries the CEO's default, so the company never waits forever. */

/** A / D / J / K do nothing while the key is already handled, the user is
    typing anywhere, or something covers this page (a dialog, the palette,
    or a thread widened over it). */
function needsKeysBlocked(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return true;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return true;
  /* The shell's overlay check — menus, popovers, vendored dialogs. Not a
     second detector. A widened thread is the opened record covering the
     page (`data-covers`); a thread beside the page is not. */
  if (foreignOverlayOpen()) return true;
  if (document.querySelector('aside[aria-label="Opened record"][data-covers]'))
    return true;
  const el = e.target as HTMLElement | null;
  if (!el?.closest) return false;
  if (el.isContentEditable || el.closest('[contenteditable="true"]'))
    return true;
  if (
    el.closest(
      '[role="textbox"], [data-lilos-terminal], [role="dialog"], aside[aria-label="Opened record"]',
    )
  )
    return true;
  const field = el.closest("textarea, select, input");
  if (!field) return false;
  if (field.tagName !== "INPUT") return true;
  /* A checkbox is a choice, not typing, so A still approves after
     "Allow this next time". A text field swallows the key. */
  const type = (field as HTMLInputElement).type;
  return type !== "checkbox" && type !== "radio" && type !== "button";
}

/** One line in a list: a quiet kind word, title + meta, then what's on the right. */
function Item({
  kind,
  title,
  meta,
  onClick,
  children,
}: {
  kind: string;
  title: string;
  meta: ReactNode;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <RowButton
      onClick={onClick}
      className="flex min-h-[54px] items-center gap-3.5 border-[var(--v3-line)] border-b py-2"
    >
      <span className="w-24 shrink-0 text-[12.5px] text-muted-foreground/70">
        {kind}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground">{title}</div>
        <div className="mt-px truncate text-[13px] text-muted-foreground">
          {meta}
        </div>
      </div>
      {children}
    </RowButton>
  );
}

/** Buttons inside a clickable row act on their own; they must not open the row. */
function Stop({ children }: { children: ReactNode }) {
  return (
    <span
      className="flex items-center gap-2"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </span>
  );
}

export function V3Needs({ data, go, act }: V3PageProps) {
  // Oldest first. Real asks carry `at`; prototype rows only have minutes.
  const asks = useMemo(
    () =>
      [...data.asks].sort((a, b) => {
        if (a.at !== undefined && b.at !== undefined) return a.at - b.at;
        return b.waiting - a.waiting;
      }),
    [data.asks],
  );
  const [selected, setSelected] = useState<string>();
  const [allow, setAllow] = useState<Record<string, boolean>>({});
  const current = asks.find((a) => a.id === selected) ?? asks[0];
  const index = current ? asks.indexOf(current) : -1;

  // Keys read the latest asks through the effect deps; re-binding is cheap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (needsKeysBlocked(e) || !current) return;
      const k = e.key.toLowerCase();
      if (k === "a" && current.kind === "approval")
        act.approve(current.id, allow[current.id]);
      else if (k === "d" && current.kind === "approval") act.deny(current.id);
      else if (k === "j")
        setSelected(asks[Math.min(index + 1, asks.length - 1)].id);
      else if (k === "k") setSelected(asks[Math.max(index - 1, 0)].id);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, allow, asks, current, index]);

  const stuck = data.tickets.filter((t) => t.status === "stuck" && t.fallback);
  const results = useMemo(() => resultsToLookAt(data), [data]);

  const others = asks.filter((a) => a !== current);
  const handleAt = stuck.map((t) => t.fallback?.at).sort()[0];

  return (
    <Page>
      <Title>Needs you</Title>

      <div className="flex flex-wrap gap-x-[18px] gap-y-1.5 text-[13.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-[7px]">
          <StatusDot status="needs" />
          <span>
            <b className="font-semibold text-foreground">{asks.length}</b>{" "}
            waiting on you
          </span>
        </span>
        {stuck.length > 0 && (
          <span className="inline-flex items-center gap-[7px]">
            <StatusDot status="waiting" />
            <span>
              <b className="font-semibold text-foreground">{stuck.length}</b>{" "}
              the CEO will handle
              {handleAt && ` at ${handleAt}`}
            </span>
          </span>
        )}
        <span className="inline-flex items-center gap-[7px]">
          <StatusDot status="working" />
          <span>
            <b className="font-semibold text-foreground">{results.length}</b>{" "}
            results to look at
          </span>
        </span>
      </div>

      {current ? (
        <>
          <OpenAsk
            ask={current}
            data={data}
            go={go}
            act={act}
            allow={!!allow[current.id]}
            setAllow={(v) => setAllow((s) => ({ ...s, [current.id]: v }))}
          />
          {/* D-#19: the hint only names a key that does something. A question
              has no approve or deny. */}
          <p className="mt-2 text-[12.5px] text-muted-foreground/70">
            {current.kind === "approval"
              ? "A approve · D deny · J/K move"
              : "J/K move"}
          </p>
        </>
      ) : (
        <p className="mt-6 border-[var(--v3-line)] border-y py-3.5 text-[14px] text-muted-foreground">
          You're all caught up
        </p>
      )}

      {others.length > 0 && (
        <>
          <Section title="Waiting on you" count={`${others.length} more`} />
          <div className="border-[var(--v3-line)] border-t">
            {others.map((a) => {
              const from = agentOf(data, a.from);
              return (
                <Item
                  key={a.id}
                  kind={a.kind === "question" ? "Question" : "Approval"}
                  title={a.title}
                  onClick={() => setSelected(a.id)}
                  meta={
                    <>
                      {askTag(data, a)} ·{" "}
                      <b className="font-medium text-foreground">
                        {from?.name ?? FORMER_AGENT}
                      </b>
                      {from?.id === data.ceoId && (
                        <>
                          {" "}
                          <CeoMark />
                        </>
                      )}{" "}
                      · waiting {ago(a.waiting)}
                    </>
                  }
                >
                  {a.fallback && (
                    <span className={CHIP}>
                      {a.fallback.at} {a.fallback.does}
                    </span>
                  )}
                </Item>
              );
            })}
          </div>
        </>
      )}

      {stuck.length > 0 && (
        <>
          <Section title="The CEO will handle it — unless you step in" />
          <div className="border-[var(--v3-line)] border-t">
            {stuck.map((t) => {
              const thread = threadsOf(data, t.id).find(
                (x) => x.status === "stuck",
              );
              const open = () =>
                thread
                  ? go({ page: "thread", id: thread.id })
                  : go({ page: "ticket", id: t.id });
              return (
                <Item
                  key={t.id}
                  kind="Stuck"
                  title={t.title}
                  onClick={open}
                  meta={
                    <>
                      {t.id} ·{" "}
                      {t.owner ? (
                        <b className="font-medium text-foreground">
                          {agentNameOf(data, t.owner)}
                        </b>
                      ) : (
                        "Unassigned"
                      )}
                      {t.owner === data.ceoId && (
                        <>
                          {" "}
                          <CeoMark />
                        </>
                      )}{" "}
                      · <span className={INK.stuck}>{t.stuckWhy}</span>
                    </>
                  }
                >
                  <span className={CHIP}>
                    {t.fallback?.at} {t.fallback?.does}
                  </span>
                  <Stop>
                    {thread && (
                      <Btn small onClick={() => act.stop(thread.id)}>
                        Stop instead
                      </Btn>
                    )}
                    <Btn small onClick={open}>
                      Open
                    </Btn>
                  </Stop>
                </Item>
              );
            })}
          </div>
        </>
      )}

      {results.length > 0 && (
        <>
          <Section title="Results to look at — no action needed" />
          <div className="border-[var(--v3-line)] border-t">
            {results.map((r) => (
              <Item
                key={r.key}
                kind="Finished"
                title={r.title}
                onClick={() => {
                  if (r.threadId) {
                    if (r.unseen) act.markSeen(r.threadId);
                    go({ page: "thread", id: r.threadId });
                  } else if (r.ticketId) go({ page: "ticket", id: r.ticketId });
                }}
                meta={
                  <>
                    {r.tag} ·{" "}
                    {r.by ? (
                      <b className="font-medium text-foreground">
                        {agentNameOf(data, r.by)}
                      </b>
                    ) : (
                      "Unassigned"
                    )}
                    {r.note && ` · ${r.note}`}
                  </>
                }
              >
                <span className="shrink-0 text-[13px] text-muted-foreground/70">
                  {relativeTime(r.minutes)}
                </span>
              </Item>
            ))}
          </div>
        </>
      )}
    </Page>
  );
}
