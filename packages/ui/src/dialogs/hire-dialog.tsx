import { PlusIcon, SparklesIcon, UserPlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { EngineProfile, HireDraft, ModelOption } from "../types";
import { Field } from "./field";

/* Hire dialog. All lists (templates, engine profiles, models, channels) are app data passed in —
   this component only renders and reports the hire via onHire. `profile` is
   the picked engine profile id, or null when a new profile should be created
   on the engine from the draft. */
export function HireDialog({
  initial,
  templates,
  profiles,
  models,
  allChannels,
  onClose,
  onHire,
  usedProfiles,
}: {
  initial: HireDraft;
  templates: HireDraft[];
  profiles: EngineProfile[];
  models: ModelOption[];
  allChannels: { id: string; label: string }[];
  onClose: () => void;
  onHire: (d: HireDraft, profile: string | null, chs: string[]) => void;
  usedProfiles: string[];
}) {
  const [d, setD] = useState<HireDraft>(initial);
  const [mode, setMode] = useState<"existing" | "new">(
    initial.instructions && !templates.some((t) => t.name === initial.name)
      ? "new"
      : "existing",
  );
  const [picked, setPicked] = useState<EngineProfile | null>(null);
  const pick = (p: EngineProfile) => {
    setPicked(p);
    setD({
      name: p.name ?? p.id[0].toUpperCase() + p.id.slice(1),
      role: d.role,
      model: p.model,
      instructions: p.soul,
    });
  };
  const [chs, setChs] = useState<string[]>(["engineering"]);
  const drafted = !templates.some((t) => t.name === initial.name);
  const slug = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "employee";
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-6"
      onClick={onClose}
    >
      <div
        className="grid max-h-[90dvh] w-full max-w-3xl grid-cols-1 overflow-hidden rounded-2xl border bg-background shadow-2xl md:grid-cols-[220px_minmax(0,1fr)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hidden space-y-1 border-r bg-muted/30 p-3 md:block">
          <div className="px-2 pb-2 font-semibold">Hire an employee</div>
          <div className="mb-3 grid grid-cols-2 rounded-lg bg-muted p-0.5 text-xs">
            {(["existing", "new"] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setPicked(null);
                }}
                className={cn(
                  "rounded-md px-2 py-1",
                  mode === m
                    ? "bg-background font-medium shadow-sm"
                    : "text-muted-foreground",
                )}
              >
                {m === "existing" ? "Use profile" : "New profile"}
              </button>
            ))}
          </div>
          {mode === "existing" ? (
            <>
              <div className="px-2 pb-1 text-muted-foreground text-xs uppercase tracking-wide">
                Engine profiles
              </div>
              {profiles.map((p) => {
                const used = usedProfiles.includes(p.id);
                return (
                  <button
                    key={p.id}
                    disabled={used}
                    onClick={() => pick(p)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
                      picked?.id === p.id && "bg-muted font-medium",
                    )}
                  >
                    <HermesAvatar className="size-5" />
                    <span className="font-mono text-xs">{p.id}</span>
                    <span className="ml-auto text-muted-foreground text-[11px]">
                      {used ? "hired" : `${p.skills} skills`}
                    </span>
                  </button>
                );
              })}
            </>
          ) : (
            <>
              <div className="px-2 pb-1 text-muted-foreground text-xs uppercase tracking-wide">
                Start from
              </div>
              {templates.map((t) => (
                <button
                  key={t.name}
                  onClick={() => setD(t)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted",
                    d.role === t.role && "bg-muted font-medium",
                  )}
                >
                  <HermesAvatar className="size-5" />
                  {t.name}
                  <span className="ml-auto text-muted-foreground text-xs">
                    {t.role}
                  </span>
                </button>
              ))}
              <button
                onClick={() =>
                  setD({
                    name: "",
                    role: "",
                    model: models[0],
                    instructions: "",
                  })
                }
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
              >
                <PlusIcon className="size-4" />
                Blank
              </button>
            </>
          )}
          <div className="mt-3 rounded-lg border border-dashed p-2 text-muted-foreground text-xs">
            <SparklesIcon className="mb-1 size-3.5" />
            Or ask an employee in chat:{" "}
            <i>"draft an employee that triages flaky tests"</i>. It posts a hire
            card for your approval.
          </div>
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="flex items-center gap-3 border-b p-4">
            <HermesAvatar className="size-10" />
            <div className="flex-1">
              <div className="font-semibold">{d.name || "New employee"}</div>
              <div className="text-muted-foreground text-xs">
                {mode === "existing" ? (
                  picked ? (
                    <>
                      Uses profile <code>{picked.id}</code> as-is
                    </>
                  ) : (
                    "Pick an engine profile on the left"
                  )
                ) : drafted ? (
                  "Drafted by Builder · review before hiring"
                ) : (
                  "Creates a new engine profile"
                )}
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose}>
              <XIcon />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name (the @handle)">
                  <Input
                    value={d.name}
                    onChange={(e) => setD({ ...d, name: e.target.value })}
                    placeholder="Tester"
                  />
                </Field>
                <Field label="Role">
                  <Input
                    value={d.role}
                    onChange={(e) => setD({ ...d, role: e.target.value })}
                    placeholder="QA automation"
                  />
                </Field>
              </div>
              {mode === "existing" ? (
                <Field label="From the profile (managed by the engine)">
                  {picked ? (
                    <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border bg-muted/30 p-3 text-xs">
                      <dt className="text-muted-foreground">Profile</dt>
                      <dd className="font-mono">{picked.id}</dd>
                      <dt className="text-muted-foreground">Model</dt>
                      <dd>{picked.model}</dd>
                      <dt className="text-muted-foreground">Skills</dt>
                      <dd>{picked.skills}</dd>
                      <dt className="text-muted-foreground">SOUL.md</dt>
                      <dd className="line-clamp-2">{picked.soul}</dd>
                    </dl>
                  ) : (
                    <p className="rounded-lg border border-dashed p-3 text-muted-foreground text-xs">
                      No profile picked. Memory, skills and model stay in the
                      profile; LilOS only adds the company record.
                    </p>
                  )}
                </Field>
              ) : (
                <>
                  <Field label="Instructions (becomes the profile's SOUL.md)">
                    <Textarea
                      value={d.instructions}
                      onChange={(e) =>
                        setD({ ...d, instructions: e.target.value })
                      }
                      className="min-h-24"
                    />
                  </Field>
                  <Field label="Model">
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {models.map((m) => (
                        <button
                          key={m}
                          onClick={() => setD({ ...d, model: m })}
                          className={cn(
                            "rounded-md border px-2.5 py-1.5 text-left text-xs",
                            d.model === m
                              ? "border-foreground bg-muted font-medium"
                              : "hover:bg-muted/50",
                          )}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  </Field>
                </>
              )}
              <Field label="Join channels">
                <div className="flex flex-wrap gap-1.5">
                  {allChannels.map((c) => {
                    const on = chs.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        onClick={() =>
                          setChs(
                            on ? chs.filter((x) => x !== c.id) : [...chs, c.id],
                          )
                        }
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs",
                          on
                            ? "border-blue-500 bg-blue-50 text-blue-700"
                            : "hover:bg-muted/50",
                        )}
                      >
                        {on && "✓ "}
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              </Field>
            </div>
          </ScrollArea>
          <div className="flex items-center gap-2 border-t bg-muted/30 p-3">
            <code className="hidden min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs sm:block">
              {mode === "existing"
                ? `link profile ${picked?.id ?? "…"} → employee @${slug}`
                : `agents.create ${slug} → persona → model`}
            </code>
            <Button variant="ghost" className="ml-auto" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!d.name || (mode === "existing" && !picked)}
              onClick={() =>
                onHire(
                  d,
                  mode === "existing" ? (picked?.id ?? null) : null,
                  chs,
                )
              }
            >
              <UserPlusIcon />
              Hire {d.name}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
