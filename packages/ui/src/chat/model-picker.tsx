import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CpuIcon,
  EyeIcon,
  Loader2Icon,
  RefreshCwIcon,
  ZapIcon,
} from "lucide-react";
import { useState } from "react";
import { ModelSelectorLogo } from "../components/ai-elements/model-selector";
import { PromptInputButton } from "../components/ai-elements/prompt-input";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { cn } from "../lib/utils";
import type {
  ModelChoice,
  ModelOption,
  ModelPickerExtras,
  ModelProvider,
  Thread,
} from "../types";
import { EffortSlider } from "./effort-slider";
import { isHidden, ModelVisibilityDialog } from "./model-visibility-dialog";

/* Provider slugs we render the models.dev logo for; anything else gets the
   generic chip — never a broken image. */
const LOGO_PROVIDERS = new Set([
  "alibaba",
  "amazon",
  "anthropic",
  "azure",
  "cerebras",
  "cohere",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "groq",
  "meta",
  "mistral",
  "moonshotai",
  "nvidia",
  "openai",
  "openrouter",
  "togetherai",
  "vercel",
  "xai",
  "zai",
]);

/* Provider slug → display name for the group headings: the models.dev names
   where the slug matches a logo, a title-cased slug otherwise. An engine that
   names its providers (Hermes: "Anthropic – CLIProxyAPI") wins over both. */
const PROVIDER_NAMES: Record<string, string> = {
  alibaba: "Alibaba",
  amazon: "Amazon",
  anthropic: "Anthropic",
  azure: "Azure",
  cerebras: "Cerebras",
  cognition: "Cognition",
  cohere: "Cohere",
  deepseek: "DeepSeek",
  fireworks: "Fireworks AI",
  "github-copilot": "GitHub Copilot",
  google: "Google",
  groq: "Groq",
  meta: "Meta",
  mistral: "Mistral AI",
  moonshotai: "Moonshot AI",
  nvidia: "NVIDIA",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  togetherai: "Together AI",
  vercel: "Vercel",
  xai: "xAI",
  zai: "Z.ai",
};

export function providerName(slug: string, providers?: ModelProvider[]) {
  return (
    providers?.find((p) => p.id === slug)?.name ??
    PROVIDER_NAMES[slug] ??
    slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function ModelLogo({
  provider,
  logo,
}: {
  provider?: string;
  logo?: string;
}) {
  const slug = logo ?? provider;
  return slug && LOGO_PROVIDERS.has(slug) ? (
    <ModelSelectorLogo
      provider={slug as "openai"}
      className="size-3.5 dark:invert"
    />
  ) : (
    <CpuIcon className="size-3.5 text-muted-foreground" />
  );
}

/* Engine effort ids are kept verbatim; only the label is friendlier. */
const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
export const effortLabel = (e: string) =>
  EFFORT_LABELS[e] ?? e.charAt(0).toUpperCase() + e.slice(1);

/* The model's starting effort: its default, else the middle of its ladder. */
export function defaultEffort(m?: ModelOption): string | undefined {
  if (!m?.efforts?.length) return undefined;
  if (m.defaultEffort && m.efforts.includes(m.defaultEffort))
    return m.defaultEffort;
  return m.efforts[Math.floor((m.efforts.length - 1) / 2)];
}

/* The session's pick for an employee default: model + its default effort, fast off. */
export function choiceFor(model: string, models: ModelOption[]): ModelChoice {
  const m = models.find((x) => x.id === model);
  return { model, provider: m?.provider, effort: defaultEffort(m) };
}

/* A session's current pick: what the session pinned, else the employee's
   default model — or the engine's own default when the employee unpins it —
   with that model's default effort (never last session's pick). */
export function sessionChoice(
  t: Pick<Thread, "model" | "provider" | "effort" | "fast">,
  employeeModel: string | undefined,
  models: ModelOption[],
  defaultModel?: string,
): ModelChoice {
  if (t.model)
    return {
      model: t.model,
      provider: t.provider,
      effort: t.effort ?? defaultEffort(findModel(models, t as ModelChoice)),
      fast: t.fast,
    };
  return choiceFor(
    employeeModel || defaultModel || models[0]?.id || "",
    models,
  );
}

function findModel(models: ModelOption[], c: ModelChoice) {
  return models.find(
    (m) =>
      m.id === c.model &&
      (c.provider === undefined || m.provider === c.provider),
  );
}

/* Codex-style picker (issue: model picker v2): one popover holding the
   reasoning-effort slider, the fast toggle and a "Model ›" row that opens the
   searchable model list. Everything applies from the next turn. The slider has
   exactly the steps the engine reported for THIS model; a model without
   `efforts` gets no slider. Refresh / Edit models render only with handlers. */
const samePick = (a: ModelChoice, b: ModelChoice) =>
  a.model === b.model &&
  a.provider === b.provider &&
  a.effort === b.effort &&
  !!a.fast === !!b.fast;

export function ModelPicker({
  value,
  models,
  onChoice,
  providers,
  visibility,
  onVisibility,
  onRefresh,
}: {
  value: ModelChoice;
  models: ModelOption[];
  onChoice: (c: ModelChoice) => void;
} & ModelPickerExtras) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"main" | "models">("main");
  const [editing, setEditing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /* The pick writes are async (relay round-trip). While the popover is open,
     the shown state is the user's latest edit — composing off the `value`
     prop would drop an earlier toggle that hasn't echoed back yet. The draft
     is dropped the moment the prop actually moves (the echo, or an external
     change): the parent stays authoritative. */
  const [picked, setPicked] = useState<ModelChoice | null>(null);
  const [prev, setPrev] = useState(value);
  if (!samePick(value, prev)) {
    setPrev(value);
    if (picked) setPicked(null);
  }
  const shown0 = picked ?? value;
  const cur = findModel(models, shown0);
  const efforts = cur?.efforts ?? [];
  const effort =
    shown0.effort && efforts.includes(shown0.effort)
      ? shown0.effort
      : defaultEffort(cur);
  const idx = effort ? efforts.indexOf(effort) : -1;
  const fast = !!(cur?.fast && shown0.fast);
  const choose = (c: ModelChoice) => {
    setPicked(c);
    onChoice(c);
  };
  const pName = (p: string) => providerName(p, providers);
  const logoOf = (p?: string) => providers?.find((x) => x.id === p)?.logo;

  const shown = models.filter((m) => !isHidden(m, visibility) || m === cur);
  const groups = new Map<string, ModelOption[]>();
  for (const p of providers ?? []) groups.set(p.id, []);
  for (const m of shown) {
    const p = m.provider ?? "";
    groups.set(p, [...(groups.get(p) ?? []), m]);
  }

  const pickModel = (m: ModelOption) => {
    const keep = effort && m.efforts?.includes(effort);
    choose({
      model: m.id,
      provider: m.provider,
      effort: keep ? effort : defaultEffort(m),
      // Explicit `false` (not a dropped field): engines that retain the fast
      // tier across a model switch must be told it's off (#92 AC-3).
      fast: m.fast ? shown0.fast : false,
    });
    setView("main");
  };
  const refresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setView("main");
            setPicked(null);
          }
        }}
      >
        <PopoverTrigger
          render={
            <PromptInputButton
              size="sm"
              className="min-w-0 shrink gap-1.5 text-xs"
              data-slot="model-picker-trigger"
            />
          }
        >
          <ModelLogo provider={cur?.provider} logo={logoOf(cur?.provider)} />
          <span className="max-w-36 truncate">{cur?.name ?? value.model}</span>
          {effort && (
            <span className="text-muted-foreground">
              · {effortLabel(effort)}
            </span>
          )}
          {fast && (
            <ZapIcon
              aria-label="Fast"
              className="size-3 fill-amber-400 text-amber-500"
            />
          )}
          <ChevronDownIcon className="size-3" />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-80 gap-0 p-0"
          aria-label="Model and reasoning"
        >
          {view === "main" ? (
            <div className="flex flex-col">
              <div className="flex items-center gap-2 px-3 pt-3">
                {cur?.fast ? (
                  <button
                    type="button"
                    aria-label="Fast mode"
                    aria-pressed={fast}
                    title={fast ? "Fast mode on" : "Fast mode off"}
                    onClick={() => choose({ ...shown0, effort, fast: !fast })}
                    className={cn(
                      "grid size-7 place-items-center rounded-md hover:bg-muted",
                      fast ? "text-amber-500" : "text-muted-foreground",
                    )}
                  >
                    <ZapIcon className={cn("size-4", fast && "fill-current")} />
                  </button>
                ) : (
                  <span className="size-7" />
                )}
                <div className="min-w-0 flex-1 text-center">
                  <div className="text-[11px] text-muted-foreground">
                    Reasoning
                  </div>
                  <div
                    key={effort ?? "none"}
                    className={cn(
                      "truncate",
                      effort
                        ? "fade-in slide-in-from-bottom-1 animate-in bg-linear-to-r from-indigo-500 via-violet-500 to-fuchsia-500 bg-clip-text font-medium text-base text-transparent duration-300 motion-reduce:animate-none"
                        : "text-muted-foreground text-sm",
                    )}
                  >
                    {effort ? effortLabel(effort) : "Not adjustable"}
                  </div>
                </div>
                <span className="size-7" />
              </div>
              {efforts.length > 1 ? (
                <div className="px-4 pt-3 pb-3">
                  <EffortSlider
                    efforts={efforts}
                    index={idx}
                    label={effortLabel}
                    onPick={(e) => choose({ ...shown0, effort: e, fast })}
                    /* The label follows the thumb live; the wire call fires
                       once on release (`onPick`). */
                    onPreview={(e) => setPicked({ ...shown0, effort: e, fast })}
                  />
                </div>
              ) : (
                <p className="px-4 pt-1 pb-3 text-center text-muted-foreground text-xs">
                  {efforts.length === 1
                    ? "This model has one reasoning level."
                    : "This model has no reasoning control."}
                </p>
              )}
              <button
                type="button"
                onClick={() => setView("models")}
                className="flex items-center gap-2 border-t px-3 py-2.5 text-left hover:bg-muted"
              >
                <ModelLogo
                  provider={cur?.provider}
                  logo={logoOf(cur?.provider)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {cur?.name ?? value.model}
                  </span>
                  {cur?.provider && (
                    <span className="block truncate text-muted-foreground text-xs">
                      {pName(cur.provider)}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground text-xs">Model</span>
                <ChevronRightIcon className="size-4 text-muted-foreground" />
              </button>
            </div>
          ) : (
            <Command className="rounded-lg!">
              <div className="flex items-center gap-1 pl-1">
                <button
                  type="button"
                  aria-label="Back"
                  onClick={() => setView("main")}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted"
                >
                  <ChevronLeftIcon className="size-4" />
                </button>
                <div className="min-w-0 flex-1">
                  <CommandInput autoFocus placeholder="Search models…" />
                </div>
              </div>
              <CommandList className="max-h-80">
                <CommandEmpty>No model found.</CommandEmpty>
                {[...groups.entries()].map(([p, items]) =>
                  items.length ? (
                    <CommandGroup
                      key={p || "other"}
                      heading={p ? pName(p) : "Other"}
                    >
                      {items.map((m) => {
                        const on = m === cur;
                        return (
                          <CommandItem
                            key={`${m.provider ?? ""}::${m.id}`}
                            value={`${m.provider ?? ""}::${m.id}`}
                            keywords={[m.id, m.name ?? "", p ? pName(p) : ""]}
                            data-checked={on}
                            onSelect={() => pickModel(m)}
                          >
                            <ModelLogo provider={m.provider} logo={logoOf(p)} />
                            <span className="min-w-0 flex-1 truncate">
                              {m.name ?? m.id}
                            </span>
                            {m.fast && (
                              <ZapIcon
                                aria-label="Has fast mode"
                                className="size-3 text-muted-foreground"
                              />
                            )}
                            {on && <CheckIcon className="sr-only" />}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  ) : null,
                )}
                {(onRefresh || onVisibility) && (
                  <>
                    <CommandSeparator />
                    <CommandGroup>
                      {onRefresh && (
                        <CommandItem
                          value="__refresh"
                          disabled={refreshing}
                          onSelect={() => void refresh()}
                        >
                          {refreshing ? (
                            <Loader2Icon className="animate-spin" />
                          ) : (
                            <RefreshCwIcon />
                          )}
                          {refreshing ? "Refreshing…" : "Refresh models"}
                        </CommandItem>
                      )}
                      {onVisibility && (
                        <CommandItem
                          value="__edit"
                          onSelect={() => {
                            setOpen(false);
                            setView("main");
                            setEditing(true);
                          }}
                        >
                          <EyeIcon />
                          Edit models…
                        </CommandItem>
                      )}
                    </CommandGroup>
                  </>
                )}
              </CommandList>
            </Command>
          )}
        </PopoverContent>
      </Popover>
      {onVisibility && (
        <ModelVisibilityDialog
          open={editing}
          onOpenChange={setEditing}
          models={models}
          providers={providers}
          providerLabel={pName}
          visibility={visibility ?? { providers: [], models: [] }}
          onVisibility={onVisibility}
        />
      )}
    </>
  );
}
