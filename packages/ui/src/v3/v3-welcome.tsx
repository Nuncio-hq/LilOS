import { FolderIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Btn, Kbd, Title } from "./v3-bits";
import { ConnectRows } from "./v3-connect-rows";
import { Avatar, CeoMark } from "./v3-marks";
import { defaultAgent } from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import { Choice, Field, Steps } from "./v3-welcome-bits";
import { EngineProblem, firstRunProblem } from "./v3-welcome-engine";

/* First run: one calm column, a few short steps. Nothing to navigate yet, so
   no sidebar. Enter advances; a plain problem screen stands in for the steps
   while something the app needs is down (#885). Models and folders come
   from the app (`settings.firstRun`); a choice it has none for is not drawn. */

type StepId = "you" | "connect" | "agent" | "folder";

const NUMBER = ["Three", "Four"];

export function V3Welcome({ data, go, act }: V3PageProps) {
  const { connect, firstRun } = data.settings;
  const models = firstRun?.models ?? [];
  const folders = firstRun?.folders ?? [];
  const isCeo = !!data.ceoId;
  // The steps swap for a plain problem screen while the app cannot start
  // (#885): nothing here fixes it by typing, so typing waits.
  const problem = firstRunProblem(data);

  // Whether the engine asks to connect is fixed on arrival: approving it
  // must not make its own step vanish.
  const [showConnect] = useState(
    () => !!connect && !connect.approved && !!act.connectEngine,
  );
  const steps: { id: StepId; label: string }[] = [
    { id: "you", label: "Your name" },
    ...(showConnect
      ? [{ id: "connect" as const, label: `Connect ${connect?.engine}` }]
      : []),
    { id: "agent", label: isCeo ? "Your CEO" : "Your first agent" },
    { id: "folder", label: "First project" },
  ];
  const [step, setStep] = useState(0);
  const id = steps[step].id;

  // The OS name can arrive after this opens: the field follows the data
  // until you type in it.
  const touched = useRef(false);
  const [me, setMe] = useState(data.me);
  useEffect(() => {
    if (touched.current) return;
    setMe(data.me);
  }, [data.me]);
  const [agentName, setAgentName] = useState(defaultAgent(data)?.name ?? "");
  const [agentModel, setAgentModel] = useState<string | undefined>(
    models[0]?.label,
  );
  const [picked, setPicked] = useState(folders[0]?.path ?? "");
  const [typed, setTyped] = useState("");
  const folder = typed.trim() || picked;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const ready = {
    you: me.trim() !== "",
    connect: true,
    agent: agentName.trim() !== "",
    // No folders to offer: typing one is optional, the first chat can pick.
    folder: folder !== "" || folders.length === 0,
  }[id];
  const last = step === steps.length - 1;

  const next = async () => {
    if (!ready || busy || problem) return;
    setError(undefined);
    if (id === "connect") {
      setBusy(true);
      try {
        await act.connectEngine?.();
        setStep(step + 1);
      } catch {
        // The app has already said why; the step stays so you can retry.
      }
      setBusy(false);
      return;
    }
    if (!last) {
      setStep(step + 1);
      return;
    }
    setBusy(true);
    try {
      await act.finishSetup({
        me: me.trim(),
        agentName: agentName.trim(),
        ...(agentModel ? { agentModel } : {}),
        ...(folder ? { folder } : {}),
      });
      go({ page: "home" });
    } catch {
      setError("Couldn't finish setting up. Try again.");
      setBusy(false);
    }
  };

  // Enter advances from anywhere except a control that Enter already presses.
  const latest = useRef(next);
  latest.current = next;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.repeat || e.isComposing) return;
      if (e.target instanceof HTMLElement && e.target.closest("button, a"))
        return;
      void latest.current();
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
          AI agents that work while you are away.{" "}
          {problem
            ? "One thing needs attention first."
            : `${NUMBER[steps.length - 3]} quick steps.`}
        </p>

        {problem ? (
          <EngineProblem data={data} act={act} />
        ) : (
          <>
            <Steps steps={steps.map((s) => s.label)} at={step} />

            {/* The stepper above marks the current step by name; the step opens
                straight on its own words, not a heading that says it again. */}
            <div key={id} className="lilos-v3-line-in min-h-[300px]">
              {id === "you" && (
                <Field
                  inputRef={first}
                  label="Your name"
                  value={me}
                  onChange={(v) => {
                    touched.current = true;
                    setMe(v);
                  }}
                  placeholder="What the agents call you"
                />
              )}

              {id === "connect" && connect && (
                <div className="mt-3">
                  <p className="mb-2 text-[14px] text-muted-foreground">
                    Connected agents see the app (their chats, folders and work)
                    and act in it for you. Only chats LilOS opens are affected,
                    and you can do this later in Settings.
                  </p>
                  <ConnectRows rows={connect.rows} />
                </div>
              )}

              {id === "agent" && (
                <>
                  <p className="mt-3 text-[14.5px] text-muted-foreground">
                    {isCeo
                      ? "The CEO is a position, not a person: it splits your goals into tickets, hands them to the right agent, checks every result and writes you a short update. You can give it to anyone later."
                      : "This is the agent you start chatting with. Name it as you like; you can rename it, and add more, any time."}
                  </p>
                  <div className="mt-5 flex items-end gap-3">
                    <Avatar
                      name={agentName || "C"}
                      tone={isCeo ? "c" : "n"}
                      size={36}
                      className="mb-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <Field
                        inputRef={first}
                        label="Name"
                        value={agentName}
                        onChange={setAgentName}
                        placeholder="Chief"
                      />
                    </div>
                    {isCeo && <CeoMark className="mb-2.5" />}
                  </div>
                  {models.length > 0 && (
                    <>
                      <div className="mt-5 mb-2 text-[13px] text-muted-foreground">
                        Model
                      </div>
                      <div
                        role="radiogroup"
                        aria-label="Model"
                        className="space-y-2"
                      >
                        {models.map((m) => (
                          <Choice
                            key={m.label}
                            on={agentModel === m.label}
                            onClick={() => setAgentModel(m.label)}
                            title={m.label}
                            note={m.note}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}

              {id === "folder" && (
                <>
                  <p className="mt-3 mb-3 text-[14.5px] text-muted-foreground">
                    Agents work inside a folder on this Mac. Pick the first one;
                    add more any time.
                  </p>
                  {folders.length > 0 && (
                    <div
                      role="radiogroup"
                      aria-label="Folder"
                      className="space-y-2"
                    >
                      {folders.map((f) => (
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
                  )}
                  {act.pickFolder && (
                    <div className="mt-3">
                      <Btn
                        onClick={() =>
                          act.pickFolder?.((path) => setTyped(path))
                        }
                      >
                        Choose folder…
                      </Btn>
                    </div>
                  )}
                  <Field
                    label={
                      folders.length > 0 || act.pickFolder
                        ? "Or type a path"
                        : "Path"
                    }
                    value={typed}
                    onChange={setTyped}
                    placeholder="~/Code/my-project"
                    mono
                  />
                </>
              )}
            </div>
          </>
        )}

        {error && (
          <p className="mt-4 text-[13.5px] text-red-600 dark:text-red-300">
            {error}
          </p>
        )}
        <div className="mt-8 flex items-center gap-2 border-[var(--v3-line)] border-t pt-4">
          {!problem && step > 0 && (
            <Btn onClick={() => setStep(step - 1)}>Back</Btn>
          )}
          {act.skipSetup && (
            <button
              type="button"
              onClick={() => {
                act.skipSetup?.();
                go({ page: "home" });
              }}
              className="text-[13px] text-muted-foreground hover:text-foreground"
            >
              Set up later
            </button>
          )}
          <span className="ml-auto flex items-center gap-2 text-[13px] text-muted-foreground">
            {!problem && ready && !busy && (
              <>
                Press <Kbd>↵</Kbd>
              </>
            )}
          </span>
          {!problem && id === "connect" && (
            <Btn onClick={() => setStep(step + 1)}>Later</Btn>
          )}
          {!problem && (
            <Btn
              primary
              onClick={() => void next()}
              className={cn(
                (!ready || busy) && "cursor-not-allowed opacity-50",
              )}
              title={ready ? undefined : "Fill this in to go on"}
            >
              {last ? "Start" : id === "connect" ? "Connect" : "Next"}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}
