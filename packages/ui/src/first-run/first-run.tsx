import {
  CheckCircle2Icon,
  ChevronRightIcon,
  Loader2Icon,
  MessageSquareIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ConnectStep } from "../connect/connect-step";
import { Field } from "../dialogs/field";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { Employee, ProfileConnection } from "../types";

const initials = (s: string) =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "L";

/* One first-run check, driven by the caller from `system.status` (#589 AC-1)
   — never a timer. `plain` is the one-line headline a failed row shows —
   plain language the caller writes; the raw reason (paths, env vars) lives
   behind "See status" only. */
export type FirstRunCheck = {
  state: "pending" | "ok" | "failed";
  plain?: string;
};

/* First run: open the app → connect to the local relay → `default` is already the first
   employee → one click into the DM. No token, no terminal. Every tick follows the
   caller's live `checks` — a failed leg says why and links to Status (#589).
   The name/company fields fold into this same card — prefilled from the OS, persisted
   by the caller as relay settings (#118 AC-2: the step count stays at 2). */
export function FirstRun({
  employee,
  identity,
  checks,
  onSeeStatus,
  connect,
  onOpenDM,
  onSkip,
}: {
  /** The auto-hired first employee — absent while none exists (the
      employee check can't tick then, and never claims it did). */
  employee?: Employee;
  /** Prefill for the identity fields (OS-derived; can arrive after mount). */
  identity?: { name: string; company: string };
  /** Live check state (#589 AC-1): the relay leg, then the first-employee leg. */
  checks: { relay: FirstRunCheck; employee: FirstRunCheck };
  /** Opens the Status dialog — rendered on a failed leg. */
  onSeeStatus?: () => void;
  /** The "Connect Hermes to LilOS" step (issue #338), appended to the flow
      when passed: the setup card's action becomes Continue and the connect
      step is the last screen. `onConnect` applies the approval — the step
      stays open until it resolves so profile states can update live — then
      the flow finishes; "Later" finishes without connecting. */
  connect?: {
    profiles: ProfileConnection[];
    onConnect: () => void | Promise<unknown>;
  };
  /** Carries what the user typed — the caller persists it as settings. */
  onOpenDM: (identity: { name: string; company: string }) => void;
  onSkip: () => void;
}) {
  const [page, setPage] = useState<"setup" | "connect">("setup");
  const [connecting, setConnecting] = useState(false);
  const [name, setName] = useState(identity?.name ?? "");
  const [company, setCompany] = useState(identity?.company ?? "");
  const [touched, setTouched] = useState(false);
  /* Late-arriving prefill (host.user) fills the fields until the user edits. */
  useEffect(() => {
    if (!identity || touched) return;
    setName(identity.name);
    setCompany(identity.company);
  }, [identity, touched]);
  const rows: { label: string; done: string; check: FirstRunCheck }[] = [
    {
      label: "Connect to the local relay",
      done: "Connected · local relay",
      check: checks.relay,
    },
    {
      label: "Add your first employee",
      done: `${employee?.name ?? "Employee"} · ready`,
      check: checks.employee,
    },
  ];
  const ready = rows.every((r) => r.check.state === "ok");
  /* #589: once a leg fails, "Setting itself up…" is a lie — drop it. */
  const failed = rows.some((r) => r.check.state === "failed");
  const finish = () => onOpenDM({ name: name.trim(), company: company.trim() });
  if (page === "connect" && connect)
    return (
      <ConnectStep
        profiles={connect.profiles}
        connecting={connecting}
        onConnect={() => {
          setConnecting(true);
          void Promise.resolve(connect.onConnect()).then(finish, () =>
            setConnecting(false),
          );
        }}
        onLater={finish}
      />
    );
  return (
    <div
      data-first-run
      className="fixed inset-0 z-50 grid place-items-center bg-background/95 p-6"
    >
      <div className="w-full max-w-sm rounded-2xl border bg-background p-6 shadow-2xl">
        <div className="mb-4 grid size-10 place-items-center rounded-xl bg-foreground font-bold text-background">
          {initials(company)}
        </div>
        <h1 className="font-semibold text-xl">Welcome to LilOS</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          {failed
            ? "One chat for your AI employees."
            : "One chat for your AI employees. Setting itself up…"}
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Field label="Your name">
            <Input
              aria-label="Your name"
              value={name}
              onChange={(ev) => {
                setName(ev.target.value);
                setTouched(true);
              }}
            />
          </Field>
          <Field label="Company name">
            <Input
              aria-label="Company name"
              value={company}
              onChange={(ev) => {
                setCompany(ev.target.value);
                setTouched(true);
              }}
            />
          </Field>
        </div>
        <div className="mt-5 space-y-3">
          {rows.map((r, i) => {
            const { state, plain } = r.check;
            return (
              <div
                key={r.label}
                data-first-run-step
                data-state={state}
                className="flex items-start gap-2.5 text-sm"
              >
                {state === "ok" ? (
                  <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                ) : state === "failed" ? (
                  <XCircleIcon className="mt-0.5 size-4 shrink-0 text-red-600" />
                ) : (
                  <Loader2Icon className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "flex items-center gap-1.5",
                      state !== "ok" && "text-muted-foreground",
                    )}
                  >
                    {state === "ok" ? r.done : r.label}
                    {i === 1 && state === "ok" && (
                      <HermesAvatar status="online" className="size-5" />
                    )}
                  </span>
                  {/* #589 AC-1: a failed leg shows the caller's plain headline
                      + See status at full width — never the raw reason. */}
                  {state === "failed" && (
                    <span className="mt-0.5 block text-red-600 text-xs">
                      {plain && <span className="block">{plain}</span>}
                      {onSeeStatus && (
                        <button
                          type="button"
                          onClick={onSeeStatus}
                          className="underline underline-offset-2 hover:text-red-800"
                        >
                          See status
                        </button>
                      )}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        <div className="mt-6 flex items-center gap-2">
          <Button
            disabled={!ready || !name.trim()}
            onClick={() => (connect ? setPage("connect") : finish())}
            className="flex-1"
          >
            {connect ? (
              <>
                Continue
                <ChevronRightIcon />
              </>
            ) : (
              <>
                <MessageSquareIcon />
                Open DM{employee ? ` with ${employee.name}` : ""}
              </>
            )}
          </Button>
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="mt-3 w-full text-center text-muted-foreground text-xs hover:text-foreground"
        >
          Set up later
        </button>
      </div>
    </div>
  );
}
