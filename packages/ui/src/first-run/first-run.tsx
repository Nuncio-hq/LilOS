import { CheckCircle2Icon, Loader2Icon, MessageSquareIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Field } from "../dialogs/field";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { Employee } from "../types";

const initials = (s: string) =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "L";

/* First run: open the app → connect to the local relay → `default` is already the first
   employee → one click into the DM. No token, no terminal. The checks drive themselves
   (mock timers here; real app: the relay handshake and `hermes profile list`).
   The name/company fields fold into this same card — prefilled from the OS, persisted
   by the caller as relay settings (#118 AC-2: the step count stays at 2). */
export function FirstRun({
  employee,
  identity,
  onOpenDM,
  onSkip,
}: {
  employee: Employee;
  /** Prefill for the identity fields (OS-derived; can arrive after mount). */
  identity?: { name: string; company: string };
  /** Carries what the user typed — the caller persists it as settings. */
  onOpenDM: (identity: { name: string; company: string }) => void;
  onSkip: () => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState(identity?.name ?? "");
  const [company, setCompany] = useState(identity?.company ?? "");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    const t1 = setTimeout(() => setStep(1), 600);
    const t2 = setTimeout(() => setStep(2), 1400);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);
  /* Late-arriving prefill (host.user) fills the fields until the user edits. */
  useEffect(() => {
    if (!identity || touched) return;
    setName(identity.name);
    setCompany(identity.company);
  }, [identity, touched]);
  const rows = [
    { label: "Connect to the local relay", done: "Connected · local relay" },
    {
      label: "Add your first employee",
      done: `${employee.name} · ready`,
    },
  ];
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
          One chat for your AI employees. Setting itself up…
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
            const done = step > i;
            return (
              <div
                key={r.label}
                data-first-run-step
                className="flex items-center gap-2.5 text-sm"
              >
                {done ? (
                  <CheckCircle2Icon className="size-4 shrink-0 text-emerald-600" />
                ) : (
                  <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
                )}
                <span className={cn(!done && "text-muted-foreground")}>
                  {done ? r.done : r.label}
                </span>
                {i === 1 && done && (
                  <HermesAvatar status="online" className="size-5" />
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-6 flex items-center gap-2">
          <Button
            disabled={step < 2 || !name.trim()}
            onClick={() =>
              onOpenDM({ name: name.trim(), company: company.trim() })
            }
            className="flex-1"
          >
            <MessageSquareIcon />
            Open DM with {employee.name}
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
