import { FolderIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Avatar, Btn, CeoMark, Kbd, Title } from "./v3-bits";
import { EngineFix, EngineState } from "./v3-settings-bits";
import type { V3PageProps } from "./v3-types";
import { CheckRow, Choice, Field, Steps } from "./v3-welcome-bits";

/* First run: one calm column, four short steps. Nothing to navigate yet, so
   no sidebar. Enter advances; the engine check blocks the way on until the
   engine is fine, with the steps to fix it right there. */

const STEPS = [
  "You and your company",
  "Engine check",
  "Your CEO",
  "First project",
];

const MODELS = [
  { id: "Opus 5.5 · High", note: "Best judgement; the default." },
  { id: "Sonnet 5 · Medium", note: "Faster and cheaper." },
];

const FOLDERS = [
  { path: "~/Code/LilOS", note: "Git repository · used 2 days ago" },
  { path: "~/Code/heardback", note: "Git repository · used last week" },
  { path: "~/Code/qrit", note: "Git repository · used last month" },
];

export function V3Welcome({ data, go, act }: V3PageProps) {
  const { engine } = data.settings;
  const [step, setStep] = useState(0);
  const [me, setMe] = useState(data.me);
  const [company, setCompany] = useState(data.company);
  const [ceoName, setCeoName] = useState("Chief");
  const [ceoModel, setCeoModel] = useState(MODELS[0].id);
  const [picked, setPicked] = useState(FOLDERS[0].path);
  const [typed, setTyped] = useState("");
  const folder = typed.trim() || picked;

  // Engine check: relay first, then the engine. `n` counts finished legs.
  const [n, setN] = useState(0);
  const [run, setRun] = useState(0);
  useEffect(() => {
    const legs: [number, number][] =
      run === 0
        ? [
            [600, 1],
            [1400, 2],
          ]
        : [[1000, 2]];
    const ids = legs.map(([ms, to]) => window.setTimeout(() => setN(to), ms));
    return () => {
      for (const id of ids) window.clearTimeout(id);
    };
  }, [run]);
  const engineOk = engine.state === "ok";
  const checked = n === 2;

  const ready = [
    me.trim() !== "" && company.trim() !== "",
    checked && engineOk,
    ceoName.trim() !== "",
    folder !== "",
  ][step];
  const last = step === STEPS.length - 1;
  const next = () => {
    if (!ready) return;
    if (!last) {
      setStep(step + 1);
      return;
    }
    act.finishSetup({
      company: company.trim(),
      me: me.trim(),
      ceoName: ceoName.trim(),
      ceoModel,
      folder,
    });
    go({ page: "home" });
  };

  // Enter advances from anywhere except a control that Enter already presses.
  const latest = useRef(next);
  latest.current = next;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.repeat || e.isComposing) return;
      if (e.target instanceof HTMLElement && e.target.closest("button, a"))
        return;
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Land in the first field of the step that has one.
  const first = useRef<HTMLInputElement>(null);
  // Refocus on each step change; steps without a field leave focus alone.
  useEffect(() => first.current?.focus(), [step]);

  return (
    <div className="@container min-h-full">
      <div className="mx-auto w-full max-w-[560px] px-6 pt-[10vh] pb-16">
        <Title>Welcome to LilOS</Title>
        <p className="-mt-1 text-[15px] text-muted-foreground">
          A company of AI agents that works while you are away. Four quick
          steps.
        </p>
        <Steps steps={STEPS} at={step} />

        <div key={step} className="lilos-v3-line-in min-h-[300px]">
          <h2 className="font-semibold text-[17px]">{STEPS[step]}</h2>

          {step === 0 && (
            <>
              <Field
                inputRef={first}
                label="Your name"
                value={me}
                onChange={setMe}
                placeholder="What the agents call you"
              />
              <Field
                label="Company name"
                value={company}
                onChange={setCompany}
                placeholder="Your company"
              />
            </>
          )}

          {step === 1 && (
            <div className="mt-3">
              <p className="mb-1 text-[14px] text-muted-foreground">
                LilOS runs on your Mac. This makes sure everything it needs is
                there.
              </p>
              <CheckRow
                state={n >= 1 ? "ok" : "run"}
                label="Local relay"
                result="Connected"
              />
              <CheckRow
                state={
                  n < 1 ? "wait" : n < 2 ? "run" : engineOk ? "ok" : "fail"
                }
                label={`Engine ${engine.name}${engine.state === "missing" ? "" : ` ${engine.version}`}`}
                result={engineOk ? "Ready" : <EngineState engine={engine} />}
              />
              {checked && !engineOk && (
                <div className="mt-4">
                  <EngineFix engine={engine} />
                  <div className="mt-4">
                    <Btn
                      small
                      onClick={() => {
                        // The mock engine stays as it is: still blocked.
                        setN(1);
                        setRun(run + 1);
                      }}
                    >
                      Check again
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <>
              <p className="mt-3 text-[14.5px] text-muted-foreground">
                The CEO is a position, not a person: it splits your goals into
                tickets, hands them to the right agent, checks every result and
                writes you a short update. You can give it to anyone later.
              </p>
              <div className="mt-5 flex items-end gap-3">
                <Avatar
                  name={ceoName || "C"}
                  tone="c"
                  size={36}
                  className="mb-0.5"
                />
                <div className="min-w-0 flex-1">
                  <Field
                    inputRef={first}
                    label="Name"
                    value={ceoName}
                    onChange={setCeoName}
                    placeholder="Chief"
                  />
                </div>
                <CeoMark className="mb-2.5" />
              </div>
              <div className="mt-5 mb-2 text-[13px] text-muted-foreground">
                Model
              </div>
              <div
                role="radiogroup"
                aria-label="CEO model"
                className="space-y-2"
              >
                {MODELS.map((m) => (
                  <Choice
                    key={m.id}
                    on={ceoModel === m.id}
                    onClick={() => setCeoModel(m.id)}
                    title={m.id}
                    note={m.note}
                  />
                ))}
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <p className="mt-3 mb-3 text-[14.5px] text-muted-foreground">
                Agents work inside a folder on this Mac. Pick the first one; add
                more any time.
              </p>
              <div role="radiogroup" aria-label="Folder" className="space-y-2">
                {FOLDERS.map((f) => (
                  <Choice
                    key={f.path}
                    on={folder === f.path}
                    onClick={() => {
                      setPicked(f.path);
                      setTyped("");
                    }}
                    title={f.path}
                    note={f.note}
                    icon={
                      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                    }
                  />
                ))}
              </div>
              <Field
                label="Or type a path"
                value={typed}
                onChange={setTyped}
                placeholder="~/Code/my-project"
                mono
              />
            </>
          )}
        </div>

        <div className="mt-8 flex items-center gap-2 border-[var(--v3-line)] border-t pt-4">
          {step > 0 && <Btn onClick={() => setStep(step - 1)}>Back</Btn>}
          <span className="ml-auto flex items-center gap-2 text-[13px] text-muted-foreground">
            {ready && (
              <>
                Press <Kbd>↵</Kbd>
              </>
            )}
          </span>
          <Btn
            primary
            onClick={next}
            className={cn(!ready && "cursor-not-allowed opacity-50")}
            title={
              ready
                ? undefined
                : step === 1
                  ? "The engine has to be ready first"
                  : "Fill this in to go on"
            }
          >
            {last ? "Open my company" : "Next"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
