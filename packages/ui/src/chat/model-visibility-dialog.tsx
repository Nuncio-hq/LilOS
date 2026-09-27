import { SearchIcon } from "lucide-react";
import { useState } from "react";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Switch } from "../components/ui/switch";
import type { ModelOption, ModelProvider, ModelVisibility } from "../types";

/* Hide/show models in the picker (Hermes Desktop's "Edit models…", ported as
   an idea from apps/desktop/src/store/model-visibility.ts — MIT, NousResearch).
   One list for every employee, owned by the app. Changes apply immediately; a
   hidden provider also hides the models it adds later, and a model new since
   the last edit is visible (only explicit hides are stored). */

export const modelKey = (m: Pick<ModelOption, "id" | "provider">) =>
  `${m.provider ?? ""}::${m.id}`;

export function isHidden(m: ModelOption, v?: ModelVisibility): boolean {
  if (!v) return false;
  return (
    (!!m.provider && v.providers.includes(m.provider)) ||
    v.models.includes(modelKey(m))
  );
}

type ProviderState = "all" | "some" | "none";

function providerState(
  id: string,
  models: ModelOption[],
  v: ModelVisibility,
): ProviderState {
  if (v.providers.includes(id)) return "none";
  const hidden = models.filter((m) => v.models.includes(modelKey(m))).length;
  if (hidden === 0) return "all";
  return hidden === models.length ? "none" : "some";
}

/* Provider checkbox: checked → hide the whole provider; otherwise show all of it. */
function toggleProvider(
  id: string,
  models: ModelOption[],
  v: ModelVisibility,
): ModelVisibility {
  const keys = new Set(models.map(modelKey));
  const rest = v.models.filter((k) => !keys.has(k));
  return providerState(id, models, v) === "all"
    ? { providers: [...v.providers, id], models: rest }
    : { providers: v.providers.filter((p) => p !== id), models: rest };
}

/* Model switch. Turning one model on inside a hidden provider un-hides the
   provider but keeps its other models hidden. */
function toggleModel(
  m: ModelOption,
  siblings: ModelOption[],
  v: ModelVisibility,
): ModelVisibility {
  const key = modelKey(m);
  if (m.provider && v.providers.includes(m.provider)) {
    return {
      providers: v.providers.filter((p) => p !== m.provider),
      models: [...v.models, ...siblings.map(modelKey).filter((k) => k !== key)],
    };
  }
  return v.models.includes(key)
    ? { ...v, models: v.models.filter((k) => k !== key) }
    : { ...v, models: [...v.models, key] };
}

export function ModelVisibilityDialog({
  open,
  onOpenChange,
  models,
  providers,
  providerLabel,
  visibility,
  onVisibility,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: ModelOption[];
  providers?: ModelProvider[];
  providerLabel: (id: string) => string;
  visibility: ModelVisibility;
  onVisibility: (v: ModelVisibility) => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const groups = new Map<string, ModelOption[]>();
  for (const id of providers?.map((p) => p.id) ?? []) groups.set(id, []);
  for (const m of models) {
    const p = m.provider ?? "";
    groups.set(p, [...(groups.get(p) ?? []), m]);
  }
  const matches = (m: ModelOption) =>
    !needle ||
    `${m.name ?? ""} ${m.id} ${providerLabel(m.provider ?? "")}`
      .toLowerCase()
      .includes(needle);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80dvh] flex-col gap-3 p-0 sm:max-w-md">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>Models</DialogTitle>
          <DialogDescription>
            Choose which models show in the picker. Applies to every employee.
          </DialogDescription>
        </DialogHeader>
        <label className="mx-4 flex items-center gap-2 rounded-lg border border-input px-2.5 py-1.5 text-sm">
          <SearchIcon className="size-4 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search models"
            aria-label="Search models"
            className="w-full bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {[...groups.entries()].map(([pid, items]) => {
            const shown = items.filter(matches);
            if (needle && shown.length === 0) return null;
            const state = pid
              ? providerState(pid, items, visibility)
              : undefined;
            const label = pid ? providerLabel(pid) : "Other";
            return (
              <section key={pid || "other"} className="py-2">
                <div className="flex items-center gap-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-medium text-muted-foreground text-xs uppercase tracking-wide">
                    {label}
                  </span>
                  <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                    {items.filter((m) => !isHidden(m, visibility)).length}/
                    {items.length}
                  </span>
                  {state && (
                    <Checkbox
                      aria-label={`Show all ${label} models`}
                      checked={state === "all"}
                      indeterminate={state === "some"}
                      onCheckedChange={() =>
                        onVisibility(toggleProvider(pid, items, visibility))
                      }
                    />
                  )}
                </div>
                {shown.map((m) => (
                  <div
                    key={modelKey(m)}
                    className="flex items-center gap-2 rounded-md py-1.5 pl-1 text-sm hover:bg-muted/50"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {m.name ?? m.id}
                    </span>
                    <Switch
                      size="sm"
                      aria-label={`Show ${m.name ?? m.id}`}
                      checked={!isHidden(m, visibility)}
                      onCheckedChange={() =>
                        onVisibility(toggleModel(m, items, visibility))
                      }
                    />
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
