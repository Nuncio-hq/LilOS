import { formatDiagnostics, toStatusComponents } from "@lilos/client-runtime";
import { FirstRun, type FirstRunCheck, StatusDialog } from "@lilos/ui";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { connectApproved, requestConnect } from "../lib/connect";
import { useAtom } from "../lib/hooks";
import { toUiEmployee } from "../lib/mapping";
import {
  currentCompany,
  currentName,
  DEFAULT_AVATAR_COLOR,
  osFullName,
  profile,
} from "../lib/me";
import { relay } from "../lib/runtime";

const ONBOARDED_KEY = "lilos-onboarded";

/* #589: the card's failed leg gets a plain headline + a step the user can
   take — raw wire reasons (paths, env vars) stay behind "See status". */
const RELAY_HEADLINE =
  "Couldn't connect — LilOS can't reach its relay on this Mac.";
const engineHeadline = (row: { reason: string } | undefined): string => {
  const r = row?.reason ?? "";
  if (/Hermes not found/i.test(r))
    return "Couldn't start your first employee — LilOS can't find Hermes on this Mac.";
  if (/too old/i.test(r))
    return "Couldn't start your first employee — Hermes is too old; update it, then reopen LilOS.";
  return "Couldn't start your first employee — the engine didn't start.";
};

/* A `system.status` leg → a first-run check (#589 AC-1): ok ticks, a
   still-waiting leg spins, a down/degraded leg fails with the caller's
   plain headline. */
const toCheck = (
  row: { state: string; reason: string } | undefined,
  plain: string,
): FirstRunCheck => {
  if (!row || row.state === "ok") return { state: "ok" };
  if (row.state === "connecting" || row.state === "blocked")
    return { state: "pending" };
  return { state: "failed", plain };
};

/**
 * `/` — first run. AC-1: when the company is brand new the harness has
 * already auto-hired the engine's `default` profile, so we show that employee
 * in the FirstRun card; a returning user (or any employee list) goes straight
 * to the first DM. The name/company fields fold into the card (prefilled from
 * the OS user); "Open DM" persists them as relay settings (#118 AC-2).
 * #589 AC-1: the two ticks follow `system.status` — a dead relay or engine
 * shows its plain reason + "See status", never a timed green.
 */
export function IndexPage() {
  const employees = useAtom(relay.employees);
  const statusPoll = useAtom(relay.status);
  const relayState = useAtom(relay.state);
  const fatal = useAtom(relay.fatal);
  const [statusOpen, setStatusOpen] = useState(false);
  const approved = useAtom(connectApproved);
  // Prefill resolves live: stored settings > the OS full name (#118 AC-4).
  useAtom(profile);
  useAtom(osFullName);
  const navigate = useNavigate();
  const first = employees[0];
  const comps = useMemo(
    () =>
      toStatusComponents({
        result: statusPoll.result,
        connection: relayState,
        fatal,
      }),
    [statusPoll, relayState, fatal],
  );
  /* #339: the harness reports `connect` only on engines with Connect
     support — when it does and Connect wasn't approved yet, the setup
     card's Continue lands on the Connect step; Later skips it without
     approving. */
  const rows = statusPoll.result?.connect;
  const connect =
    rows !== undefined && approved !== true
      ? {
          profiles: rows.length
            ? rows
            : employees
                .filter((e) => e.profile)
                .map((e) => ({
                  profile: e.profile as string,
                  employee: e.name,
                  state: "not-connected" as const,
                })),
          onConnect: requestConnect,
        }
      : undefined;

  useEffect(() => {
    if (first && localStorage.getItem(ONBOARDED_KEY)) {
      void navigate({
        to: "/dm/$employeeId",
        params: { employeeId: first.id },
        replace: true,
      });
    }
  }, [first, navigate]);

  /* The two checks follow the real legs (#589): relay, then engine+employee.
     The employee leg waits behind the relay — it can't be known while the
     relay is down — and reads the engine row once the relay answers. */
  const relayRow = comps.find((c) => c.id === "relay");
  const engineRow = comps.find((c) => c.id === "engine");
  const relayCheck = toCheck(relayRow, RELAY_HEADLINE);
  const engineCheck =
    engineRow === undefined
      ? { state: "pending" as const }
      : toCheck(engineRow, engineHeadline(engineRow));
  const employeeCheck: FirstRunCheck =
    relayCheck.state !== "ok"
      ? { state: "pending" }
      : engineCheck.state === "ok"
        ? first
          ? { state: "ok" }
          : { state: "pending" }
        : engineCheck;

  const e = first ? toUiEmployee(first) : undefined;
  const dismiss = () => localStorage.setItem(ONBOARDED_KEY, "1");
  const goDm = () =>
    first &&
    void navigate({
      to: "/dm/$employeeId",
      params: { employeeId: first.id },
    });
  return (
    <div className="min-w-0 flex-1">
      <FirstRun
        employee={e}
        identity={{ name: currentName(), company: currentCompany() }}
        checks={{ relay: relayCheck, employee: employeeCheck }}
        onSeeStatus={() => setStatusOpen(true)}
        {...(connect ? { connect } : {})}
        onOpenDM={(id) => {
          dismiss();
          // Persist what was typed — an emptied company keeps the derived
          // "<first>'s Co" rather than storing a blank.
          void relay
            .updateProfile({
              userName: id.name,
              companyName: id.company || undefined,
              avatarColor: DEFAULT_AVATAR_COLOR,
            })
            .catch(() => {});
          goDm();
        }}
        onSkip={() => {
          dismiss();
          goDm();
        }}
      />
      {statusOpen && (
        <StatusDialog
          components={comps}
          diagnostics={formatDiagnostics({
            result: statusPoll.result,
            connection: relayState,
            fatal,
            error: statusPoll.error,
            app: { name: "LilOS" },
          })}
          onClose={() => setStatusOpen(false)}
          onCopied={() => {}}
        />
      )}
    </div>
  );
}
