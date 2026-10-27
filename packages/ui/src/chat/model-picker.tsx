import { useCommandState } from "cmdk";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CpuIcon,
  EyeIcon,
  Loader2Icon,
  RefreshCwIcon,
  ZapIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { ModelSelectorLogo } from "../components/ai-elements/model-selector";
import { PromptInputButton } from "../components/ai-elements/prompt-input";
import { Button } from "../components/ui/button";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { catalogModelName } from "../lib/model-name";
import { cn } from "../lib/utils";
import type {
  ModelChoice,
  ModelOption,
  ModelPickerExtras,
  ModelProvider,
  Thread,
} from "../types";
import { EffortPicker } from "./effort-picker";
import { isHidden } from "./model-visibility";
import { ModelVisibilityDialog } from "./model-visibility-dialog";

export { effortLabel } from "./effort-picker";

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

function providerName(slug: string, providers?: ModelProvider[]) {
  return (
    providers?.find((p) => p.id === slug)?.name ??
    PROVIDER_NAMES[slug] ??
    slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function ModelLogo({ provider, logo }: { provider?: string; logo?: string }) {
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

/* The effort the engine reports for the model — or nothing. The picker
   shows "Engine default" for the unset case rather than inventing a level
   (a mid-ladder guess would display an effort the turn never ran with). */
function defaultEffort(m?: ModelOption): string | undefined {
  if (!m?.efforts?.length) return undefined;
  if (m.defaultEffort && m.efforts.includes(m.defaultEffort))
    return m.defaultEffort;
  return undefined;
}

/* The session's pick for an employee default: model + its default effort, fast off. */
export function choiceFor(
  model: string,
  models: ModelOption[],
  provider?: string,
): ModelChoice {
  const m = models.find(
    (x) =>
      x.id === model && (provider === undefined || x.provider === provider),
  );
  return { model, provider: provider ?? m?.provider, effort: defaultEffort(m) };
}

/* A session's current pick: what the session pinned, else the employee's
   default model — or the engine's own default when the employee unpins it —
   with that model's default effort (never last session's pick). */
export function sessionChoice(
  t: Pick<Thread, "model" | "provider" | "effort" | "fast">,
  employeeModel: string | undefined,
  models: ModelOption[],
  defaultModel?: string,
  defaultProvider?: string,
): ModelChoice {
  if (t.model)
    return {
      model: t.model,
      provider: t.provider,
      effort: t.effort ?? defaultEffort(findModel(models, t as ModelChoice)),
      fast: t.fast,
    };
  /* The engine default is `{provider?, id}` — ids are unique only per
     provider, so its provider disambiguates a shared id. An employee's
     stored model is a bare id: first match there. */
  return choiceFor(
    employeeModel || defaultModel || models[0]?.id || "",
    models,
    employeeModel ? undefined : defaultProvider,
  );
}

function findModel(models: ModelOption[], c: ModelChoice) {
  return models.find(
    (m) =>
      m.id === c.model &&
      (c.provider === undefined || m.provider === c.provider),
  );
}

/* D-#140 — the picker's effective list (AC-1): the engine's catalog plus the
   session's own pick when the catalog omits it — the picker always shows the
   model the session actually runs, marked `notInList` so its row can carry
   the "Not in list" hint. Only the session's pick is ever added; the engine's
   reported rows are passed through untouched (LilOS invents no models — the
   path back to the catalog is Refresh, `models.list {refresh:true}`, the
   engine's live catalog). Not: merging configured or preset models into
   `models.list` — that re-advertises what the engine hides on purpose
   (Hermes' account-gated models), so picks would fail — or engine-specific
   picker branches. */
export function withSessionModel(
  models: ModelOption[],
  pick: ModelChoice,
): ModelOption[] {
  if (!pick.model || findModel(models, pick)) return models;
  return [
    ...models,
    { id: pick.model, provider: pick.provider, notInList: true },
  ];
}

/* #886's two plain dropdowns: one trigger opens the searchable model list
   grouped by provider (search box on top), a second opens the reasoning
   effort as a radio menu listing exactly the levels the engine reported
   for THIS model — hidden when it reports none. No popover home, no
   slider. Fast lives as a row in the model list's footer. Everything
   applies from the next turn. Refresh / Edit models render only with
   handlers. */
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
  open: openProp,
  onOpenChange,
}: {
  value: ModelChoice;
  models: ModelOption[];
  /* A rejected promise means the pick was not applied: the chip lets go of
     it and shows what the session really runs again. */
  onChoice: (c: ModelChoice) => void | Promise<unknown>;
  /* Controlled open: the host's `/model` command opens the same picker a
     click would. Undefined falls back to the popover's own state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
} & ModelPickerExtras) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const [editing, setEditing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /* A catalog refresh that ran and still didn't offer the session's model is
     the evidence for the switch-away warning (#140 AC-3) — without it we only
     know the CACHE is stale, not that the engine doesn't offer the model. */
  const [refreshed, setRefreshed] = useState(false);
  /* Another model the user picked while the session's own was absent even
     post-refresh — held for the warn dialog (#140 AC-3). */
  const [pendingLeave, setPendingLeave] = useState<ModelOption | null>(null);
  /* The pick writes are async (relay round-trip). While the popover is open,
     the shown state is the user's latest edit — composing off the `value`
     prop would drop an earlier toggle that hasn't echoed back yet. Each
     write is queued. An echo is matched against that list: it drops itself
     and every write before it, and the draft stays while a newer write is
     still queued. Popping the head before the search made the model echo
     (effort still medium) look like the engine had normalised High away,
     and wiped Fast with it (#807). An echo that matches nothing in flight
     is the engine's own answer — a refusal, a normalised effort, or another
     session — so the draft goes. Fast refused can come back as `undefined`
     (the harness writes null and the relay drops it), which does not match
     a Fast-on write. */
  const [picked, setPicked] = useState<ModelChoice | null>(null);
  const [inflight, setInflight] = useState<ModelChoice[]>([]);
  const echoKey = `${value.model}\0${value.provider ?? ""}\0${value.effort ?? ""}\0${value.fast === true ? 1 : value.fast === false ? 0 : ""}`;
  const [handled, setHandled] = useState(echoKey);
  if (echoKey !== handled) {
    setHandled(echoKey);
    setRefreshed(false);
    const at = inflight.findIndex((s) => samePick(value, s));
    if (at >= 0) {
      const rest = inflight.slice(at + 1);
      if (rest.length === 0) {
        if (picked) setPicked(null);
        if (inflight.length > 0) setInflight([]);
      } else {
        setInflight(rest);
      }
    } else if (picked || inflight.length > 0) {
      setPicked(null);
      setInflight([]);
    }
  }
  const shown0 = picked ?? value;
  /* `merged` adds the session's own model when the catalog omits it (#140
     AC-1); `value` is the session's pick — never the local draft. */
  const merged = withSessionModel(models, value);
  const cur = findModel(merged, shown0);
  /* The session's own model row — when the catalog omits it, switching away
     needs the post-refresh warning (AC-3). */
  const sessionRow = findModel(merged, value);
  const efforts = cur?.efforts ?? [];
  const effort =
    shown0.effort && efforts.includes(shown0.effort)
      ? shown0.effort
      : defaultEffort(cur);
  const fast = !!(cur?.fast && shown0.fast);
  /* `inflight` mirrored for the async failure path, which runs after the
     render that queued the write. */
  const queue = useRef(inflight);
  queue.current = inflight;
  const choose = (c: ModelChoice) => {
    setPicked(c);
    queue.current = [...queue.current, c];
    setInflight(queue.current);
    /* A write the host could not apply never echoes, so without this the
       chip would keep showing a model or effort the session isn't on. Drop
       just that write; a newer one still pending keeps the chip. */
    const failed = () => {
      const at = queue.current.lastIndexOf(c);
      if (at < 0) return;
      const rest = queue.current.filter((_, i) => i !== at);
      queue.current = rest;
      setInflight(rest);
      setPicked((p) => (p === c ? (rest.at(-1) ?? null) : p));
    };
    try {
      void Promise.resolve(onChoice(c)).catch(failed);
    } catch {
      failed();
    }
  };
  const pName = (p: string) => providerName(p, providers);
  const logoOf = (p?: string) => providers?.find((x) => x.id === p)?.logo;

  /* The session's own (merged) row is never hidden — the picker must show
     the model the session runs even when its provider is hidden (#140 AC-1). */
  const shown = merged.filter(
    (m) => m.notInList || !isHidden(m, visibility) || m === cur,
  );
  const groups = new Map<string, ModelOption[]>();
  for (const p of providers ?? []) groups.set(p.id, []);
  for (const m of shown) {
    const p = m.provider ?? "";
    groups.set(p, [...(groups.get(p) ?? []), m]);
  }

  /* #194: a real catalog is hundreds of rows — provider groups start
     collapsed except the current model's. `overrides` holds the groups the
     user explicitly toggled (remembered for the picker's lifetime); an
     untouched group follows the default rule, so a new current model's
     provider opens on its own. While searching, collapse is ignored. */
  const [overrides, setOverrides] = useState<Map<string, boolean> | null>(null);
  const curProvider = cur?.provider ?? shown0.provider ?? "";
  const expanded = (p: string) => overrides?.get(p) ?? p === curProvider;
  const toggleGroup = (p: string) => {
    const next = new Map(overrides ?? []);
    next.set(p, !expanded(p));
    setOverrides(next);
  };

  const applyPick = (m: ModelOption) => {
    const keep = effort && m.efforts?.includes(effort);
    choose({
      model: m.id,
      provider: m.provider,
      effort: keep ? effort : defaultEffort(m),
      // Explicit `false` (not a dropped field): engines that retain the fast
      // tier across a model switch must be told it's off (#92 AC-3).
      fast: m.fast ? shown0.fast : false,
    });
    setOpen(false);
  };
  const pickModel = (m: ModelOption) => {
    /* A merged row is a display row, not a pick: the engine's catalog doesn't
       offer it, so the only path back is Refresh — clicking it asks the
       engine for its live catalog (#140 AC-2, decision C). */
    if (m.notInList) {
      void refresh();
      return;
    }
    /* After a refresh that still didn't offer the session's model, switching
       away loses it: warn first, never fail silently (#140 AC-3). */
    if (sessionRow?.notInList && refreshed && m !== sessionRow) {
      setPendingLeave(m);
      return;
    }
    applyPick(m);
  };
  const refresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
      setRefreshed(true);
    } catch {
      /* The caller already said why (toast); the `refreshed` marker staying
         false is the picker's own failure signal — don't also leak an
         unhandled rejection. */
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        /* A pick closes the dropdown — but the wire draft (picked +
           in-flight queue) outlives it, so a follow-up pick composes
           against the draft, not the stale echo (#807). */
      >
        <PopoverTrigger
          render={
            <PromptInputButton
              size="sm"
              className="h-6 min-w-0 shrink gap-1.5 rounded-md px-1.5 font-normal text-[12.5px] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground aria-expanded:bg-[var(--v3-hover)] aria-expanded:text-foreground"
              data-slot="model-picker-trigger"
            />
          }
        >
          <ModelLogo provider={cur?.provider} logo={logoOf(cur?.provider)} />
          {/* #886: narrow box = icon + a short label, never a wrap. */}
          <span className="max-w-36 truncate @max-[480px]:max-w-16">
            {catalogModelName(value.model, merged, value.provider) ??
              value.model}
          </span>
          {fast && (
            <ZapIcon
              aria-label="Fast"
              className="size-3 fill-primary text-primary"
            />
          )}
          <ChevronDownIcon className="size-3 opacity-60" />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-80 gap-0 p-0"
          aria-label="Model"
        >
          <Command
            className="rounded-lg!"
            /* Open with the current model selected → cmdk scrolls its row
               into view (#194 AC-1). */
            defaultValue={cur ? `${cur.provider ?? ""}::${cur.id}` : undefined}
          >
            <CommandInput autoFocus placeholder="Search models…" />
            <CommandList className="max-h-80">
              <PickerGroups
                groups={groups}
                expanded={expanded}
                onToggle={toggleGroup}
                cur={cur}
                pickModel={pickModel}
                pName={pName}
                logoOf={logoOf}
                onRefresh={onRefresh}
              />
              {(cur?.fast || onRefresh || onVisibility) && (
                <>
                  <CommandSeparator />
                  <CommandGroup>
                    {/* Fast mode is a pick like any other — a footer row on
                        the model list rather than a third composer chip. */}
                    {cur?.fast && (
                      <CommandItem
                        value="__fast"
                        onSelect={() =>
                          choose({ ...shown0, effort, fast: !fast })
                        }
                      >
                        <ZapIcon
                          className={cn(
                            fast
                              ? "fill-primary text-primary"
                              : "text-muted-foreground",
                          )}
                        />
                        <span className="flex-1">Fast mode</span>
                        {fast && <CheckIcon />}
                      </CommandItem>
                    )}
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
        </PopoverContent>
      </Popover>
      {efforts.length > 0 && (
        <EffortPicker
          efforts={efforts}
          effort={effort}
          onPick={(e) => choose({ ...shown0, effort: e, fast })}
        />
      )}
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
      {/* Switching away from a model the refreshed catalog still doesn't
          offer means LilOS can't switch back to it — warn once, then let the
          user go ahead (#140 AC-3). */}
      <Dialog
        open={pendingLeave !== null}
        onOpenChange={(o) => {
          if (!o) setPendingLeave(null);
        }}
      >
        <DialogContent aria-label="Model not in list">
          <DialogHeader>
            <DialogTitle>Switch models?</DialogTitle>
            <DialogDescription>
              You can't switch back to {sessionRow?.id ?? "this model"} from
              LilOS — the engine doesn't offer it right now.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingLeave(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const m = pendingLeave;
                setPendingLeave(null);
                if (m) applyPick(m);
              }}
            >
              Switch anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* The provider groups of the drill-in list (#194). Each heading is a toggle
   showing provider name + model count; while the search box has text, every
   match renders expanded across providers (collapse ignored) and the empty
   note only makes sense then — cmdk hides a group whose rows all filtered
   out, so no "no matches" heading lingers. */
function PickerGroups({
  groups,
  expanded,
  onToggle,
  cur,
  pickModel,
  pName,
  logoOf,
  onRefresh,
}: {
  groups: Map<string, ModelOption[]>;
  expanded: (p: string) => boolean;
  onToggle: (p: string) => void;
  cur: ModelOption | undefined;
  pickModel: (m: ModelOption) => void;
  pName: (p: string) => string;
  logoOf: (p?: string) => string | undefined;
  onRefresh?: () => void | Promise<void>;
}) {
  const searching = useCommandState((s) => s.search.trim() !== "");
  return (
    <>
      {searching && <CommandEmpty>No model found.</CommandEmpty>}
      {[...groups.entries()].map(([p, items]) =>
        items.length ? (
          <CommandGroup
            /* Remounting on the search flip restores the catalog order cmdk's
               score-sort reorders while filtering. */
            key={`${p || "other"}:${searching ? "search" : "browse"}`}
            heading={
              <button
                type="button"
                aria-expanded={searching || expanded(p)}
                onClick={() => onToggle(p)}
                className="flex w-full cursor-pointer items-center gap-1 text-left"
              >
                <ChevronRightIcon
                  className={cn(
                    "size-3 shrink-0 transition-transform",
                    (searching || expanded(p)) && "rotate-90",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">
                  {p ? pName(p) : "Other"}
                </span>
                <span className="text-muted-foreground/70 tabular-nums">
                  {items.length}
                </span>
              </button>
            }
          >
            {(searching || expanded(p)) &&
              items.map((m) => {
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
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{m.name ?? m.id}</span>
                      {/* The session's model absent from the catalog:
                          the row hints at Refresh — the only way the
                          engine can offer it again (#140 AC-2). */}
                      {m.notInList && (
                        <span className="block text-muted-foreground text-xs">
                          Not in list
                          {onRefresh && (
                            <span className="text-primary"> · Refresh</span>
                          )}
                        </span>
                      )}
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
    </>
  );
}
