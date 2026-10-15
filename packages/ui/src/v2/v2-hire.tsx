import {
  CheckIcon,
  CodeIcon,
  MegaphoneIcon,
  SearchCheckIcon,
  TelescopeIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { ModelChoice } from "../types";
import { type V2ModelKit, V2ModelPicker } from "./v2-pickers";
import { RUNTIME_NAME, RuntimeIcon, type V2Runtime } from "./v2-runtime";

export type V2HireDraft = {
  runtime: V2Runtime;
  role: string;
  name: string;
  model: ModelChoice;
};

const ROLES: {
  id: string;
  label: string;
  icon: typeof CodeIcon;
  name: string;
}[] = [
  { id: "engineer", label: "Engineer", icon: CodeIcon, name: "Builder" },
  {
    id: "reviewer",
    label: "Reviewer",
    icon: SearchCheckIcon,
    name: "Reviewer",
  },
  { id: "marketer", label: "Marketer", icon: MegaphoneIcon, name: "Marketer" },
  { id: "research", label: "Research", icon: TelescopeIcon, name: "Scout" },
  { id: "custom", label: "Custom", icon: WandSparklesIcon, name: "" },
];

const RUNTIMES: { id: V2Runtime; soon?: boolean }[] = [
  { id: "hermes" },
  { id: "claude-code", soon: true },
  { id: "codex", soon: true },
  { id: "grok-bot", soon: true },
  { id: "muse", soon: true },
];

function Step({ n, label }: { n: number; label: string }) {
  return (
    <div className="mb-2.5 flex items-center gap-2 text-[12px] text-muted-foreground">
      <span className="grid size-4 place-items-center rounded-full bg-foreground/[0.08] font-semibold text-[10px] text-foreground/70">
        {n}
      </span>
      {label}
    </div>
  );
}

/* Hire in three picks: where it runs (logo tiles), what it does (role
   tiles), then a name and a model. Lives inside the Agents sheet. */
export function V2HireForm({
  modelKit,
  onCancel,
  onHire,
}: {
  modelKit: V2ModelKit;
  onCancel: () => void;
  onHire: (d: V2HireDraft) => void;
}) {
  const [d, setD] = useState<V2HireDraft>({
    runtime: "hermes",
    role: "engineer",
    name: "Builder 2",
    model: { model: modelKit.models[0]?.id ?? "" },
  });
  const ok = d.name.trim().length > 0;
  return (
    <div className="px-5 pt-1 pb-6">
      <div className="mb-6 flex items-center gap-3">
        <HermesAvatar name={d.name || "New"} className="size-11" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-[15px]">
            {d.name.trim() || "New agent"}
          </div>
          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <RuntimeIcon runtime={d.runtime} className="size-4 rounded-[4px]" />
            {ROLES.find((r) => r.id === d.role)?.label}
          </div>
        </div>
      </div>

      <Step n={1} label="Runs on" />
      <div className="mb-5 grid grid-cols-5 gap-2">
        {RUNTIMES.map((r) => (
          <button
            key={r.id}
            type="button"
            disabled={r.soon}
            onClick={() => setD((x) => ({ ...x, runtime: r.id }))}
            aria-pressed={d.runtime === r.id}
            title={r.soon ? `${RUNTIME_NAME[r.id]} · soon` : RUNTIME_NAME[r.id]}
            className={cn(
              "relative flex flex-col items-center gap-1.5 rounded-xl py-2.5 text-[11px] transition-colors",
              d.runtime === r.id
                ? "bg-foreground/[0.06] ring-2 ring-foreground"
                : "ring-1 ring-foreground/10 enabled:hover:bg-foreground/[0.03]",
              r.soon && "opacity-40",
            )}
          >
            <RuntimeIcon runtime={r.id} className="size-8 rounded-lg" />
            <span className="max-w-full truncate px-1">
              {RUNTIME_NAME[r.id]}
            </span>
            {d.runtime === r.id && (
              <CheckIcon className="absolute top-1.5 right-1.5 size-3" />
            )}
          </button>
        ))}
      </div>

      <Step n={2} label="Role" />
      <div className="mb-5 grid grid-cols-5 gap-2">
        {ROLES.map((r) => {
          const Icon = r.icon;
          const on = d.role === r.id;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() =>
                setD((x) => ({
                  ...x,
                  role: r.id,
                  name: r.name ? `${r.name} 2` : x.name,
                }))
              }
              aria-pressed={on}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-xl py-2.5 text-[11px] transition-colors",
                on
                  ? "bg-foreground/[0.06] ring-2 ring-foreground"
                  : "ring-1 ring-foreground/10 hover:bg-foreground/[0.03]",
              )}
            >
              <Icon className="size-5 text-foreground/75" />
              {r.label}
            </button>
          );
        })}
      </div>

      <Step n={3} label="Name and model" />
      <div className="flex items-center gap-2">
        <input
          value={d.name}
          onChange={(e) => setD((x) => ({ ...x, name: e.target.value }))}
          aria-label="Name"
          placeholder="Name"
          className="h-9 min-w-0 flex-1 rounded-xl bg-foreground/[0.04] px-3 text-[14px] outline-none ring-1 ring-foreground/10 focus:ring-foreground/30"
        />
        <div className="rounded-xl ring-1 ring-foreground/10">
          <V2ModelPicker
            kit={modelKit}
            value={d.model}
            onChoice={(model) => setD((x) => ({ ...x, model }))}
          />
        </div>
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded-full px-4 text-[13px] text-foreground/80 hover:bg-foreground/[0.05]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!ok}
          onClick={() => onHire(d)}
          className="h-9 rounded-full bg-foreground px-5 font-medium text-[13px] text-background transition-transform active:scale-[0.97] disabled:opacity-40"
        >
          Hire {d.name.trim() || ""}
        </button>
      </div>
    </div>
  );
}
