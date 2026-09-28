import { AppWindowIcon, BoxesIcon, CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Field } from "../dialogs/field";
import { cn } from "../lib/utils";
import { HumanAvatar } from "../shell/avatars";
import { StatusList } from "../shell/status";
import { ThemeToggle } from "../shell/theme-toggle";
import type {
  ApprovalPolicy,
  ConversationAccess,
  DetectedEditor,
  Human,
  ModelOption,
  ModelProvider,
  ModelVisibility,
  StatusComponent,
  Theme,
} from "../types";

/* The six section panes of SettingsView (issue #139). Each is a pure prop
   group: the app passes the group or the section doesn't exist (D-#19). All
   values come in, every control calls back out — no state lives here. */

export type GeneralProps = {
  me: Human;
  onMeChange: (me: Human) => void;
  company: string;
  onCompanyChange: (name: string) => void;
  theme?: Theme;
  onThemeChange?: (t: Theme) => void;
};

export type ApprovalsProps = {
  policy: ApprovalPolicy;
  onPolicy: (p: ApprovalPolicy) => void;
  access: ConversationAccess;
  onAccess: (a: ConversationAccess) => void;
};

export type EditorsProps = {
  detected: DetectedEditor[];
  defaultId: string | null;
  onDefault: (id: string) => void;
};

export type ModelsProps = {
  models: ModelOption[];
  providers?: ModelProvider[];
  /* Provider id → display name for the visibility dialog's groups. */
  providerLabel?: (id: string) => string;
  visibility: ModelVisibility;
  onVisibility: (v: ModelVisibility) => void;
};

export type StatusProps = {
  components: StatusComponent[];
  diagnostics: string;
  onCopied?: () => void;
};

export type AboutProps = {
  version: string;
  build?: string;
  onCheckUpdates?: () => void;
  /* Result line next to the button ("Checking…", "LilOS is up to date."). */
  updateStatus?: string;
};

/* Avatar swatches — Tailwind bg-* classes (same space as Human.color). */
const AVATAR_COLORS: { color: string; label: string }[] = [
  { color: "bg-blue-600", label: "Blue" },
  { color: "bg-cyan-600", label: "Cyan" },
  { color: "bg-emerald-600", label: "Emerald" },
  { color: "bg-violet-600", label: "Violet" },
  { color: "bg-amber-600", label: "Amber" },
  { color: "bg-rose-600", label: "Rose" },
];

function Pane({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-xl p-4 sm:p-6">
      <h2 className="mb-4 font-semibold text-base">{title}</h2>
      <div className="space-y-5">{children}</div>
    </div>
  );
}

/* A segmented single-choice row — same look as ThemeToggle, text labels. */
function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex w-fit items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "rounded-md px-3 py-3 text-foreground text-sm md:py-1.5",
            value === o.id && "bg-background shadow-sm dark:bg-white/15",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-muted-foreground text-xs">{children}</p>;
}

export function GeneralSection({ general }: { general: GeneralProps }) {
  const { me, onMeChange } = general;
  return (
    <Pane title="General">
      <Field label="Avatar colour">
        <div className="flex items-center gap-4">
          <HumanAvatar human={me} size="lg" className="rounded-full" />
          <div
            role="radiogroup"
            aria-label="Avatar colour"
            className="flex flex-wrap items-center gap-3 md:gap-2"
          >
            {AVATAR_COLORS.map(({ color, label }) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={me.color === color}
                aria-label={label}
                onClick={() => onMeChange({ ...me, color })}
                className={cn(
                  "size-11 rounded-full md:size-6",
                  color,
                  me.color === color &&
                    "ring-2 ring-foreground ring-offset-2 ring-offset-background",
                )}
              />
            ))}
          </div>
        </div>
      </Field>
      <Field label="Your name">
        <Input
          aria-label="Your name"
          value={me.name}
          onChange={(e) => onMeChange({ ...me, name: e.target.value })}
        />
      </Field>
      <Field label="Company name">
        <Input
          aria-label="Company name"
          value={general.company}
          onChange={(e) => general.onCompanyChange(e.target.value)}
        />
      </Field>
      {general.theme && general.onThemeChange && (
        <Field label="Theme">
          <div>
            <ThemeToggle
              theme={general.theme}
              setTheme={general.onThemeChange}
            />
          </div>
        </Field>
      )}
    </Pane>
  );
}

export function ApprovalsSection({ approvals }: { approvals: ApprovalsProps }) {
  return (
    <Pane title="Approvals">
      <Field label="Engine approval policy">
        <Choice<ApprovalPolicy>
          label="Engine approval policy"
          value={approvals.policy}
          onChange={approvals.onPolicy}
          options={[
            { id: "smart", label: "Smart" },
            { id: "manual", label: "Manual" },
            { id: "off", label: "Off" },
          ]}
        />
        <Hint>
          Smart runs routine steps and asks for risky ones. Manual asks every
          time. Off never asks.
        </Hint>
      </Field>
      <Field label="Default access for new conversations">
        <Choice<ConversationAccess>
          label="Default access for new conversations"
          value={approvals.access}
          onChange={approvals.onAccess}
          options={[
            { id: "ask", label: "Ask" },
            { id: "full", label: "Full access" },
          ]}
        />
        <Hint>
          Ask: a session asks before it touches files outside its folder. Full
          access: it works anywhere on this Mac.
        </Hint>
      </Field>
    </Pane>
  );
}

export function EditorsSection({ editors }: { editors: EditorsProps }) {
  return (
    <Pane title="Editors">
      <Field label="Detected editors">
        <div
          role="radiogroup"
          aria-label="Default editor"
          className="divide-y rounded-lg border"
        >
          {editors.detected.map((ed) => (
            <button
              key={ed.id}
              type="button"
              role="radio"
              aria-checked={editors.defaultId === ed.id}
              onClick={() => editors.onDefault(ed.id)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted"
            >
              <AppWindowIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-sm">
                  {ed.name}
                </span>
                {ed.path && (
                  <span className="block truncate text-muted-foreground text-xs">
                    {ed.path}
                  </span>
                )}
              </span>
              {editors.defaultId === ed.id && (
                <span className="flex shrink-0 items-center gap-1 font-medium text-muted-foreground text-xs">
                  <CheckIcon className="size-3.5" />
                  Default
                </span>
              )}
            </button>
          ))}
        </div>
        <Hint>"Open in editor" / "Reveal in Finder" use the default.</Hint>
      </Field>
    </Pane>
  );
}

export function ModelsSection({
  models,
  onManage,
}: {
  models: ModelsProps;
  onManage: () => void;
}) {
  const hidden =
    models.visibility.models.length +
    models.models.filter(
      (m) => m.provider && models.visibility.providers.includes(m.provider),
    ).length;
  return (
    <Pane title="Models">
      <div className="flex items-center gap-3 rounded-lg border p-3">
        <BoxesIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm">Picker models</div>
          <div className="text-muted-foreground text-xs">
            {hidden === 0
              ? `${models.models.length} models visible`
              : `${hidden} hidden · applies to every employee`}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-11 md:h-7"
          onClick={onManage}
        >
          Manage models…
        </Button>
      </div>
      <Hint>Same list as “Edit models…” in the model picker.</Hint>
    </Pane>
  );
}

export function StatusSection({ status }: { status: StatusProps }) {
  return (
    <Pane title="Status">
      <div className="overflow-hidden rounded-lg border">
        <StatusList components={status.components} />
      </div>
      <div>
        <Button
          variant="outline"
          size="sm"
          className="h-11 md:h-7"
          onClick={() => {
            void navigator.clipboard.writeText(status.diagnostics);
            status.onCopied?.();
          }}
        >
          <CopyIcon />
          Copy diagnostics
        </Button>
      </div>
      <Hint>Same as the status row at the bottom of the sidebar.</Hint>
    </Pane>
  );
}

export function AboutSection({ about }: { about: AboutProps }) {
  return (
    <Pane title="About">
      <div className="flex items-center gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-foreground font-bold text-background text-sm">
          L
        </div>
        <div>
          <div className="font-medium">LilOS</div>
          <div className="text-muted-foreground text-xs">{about.version}</div>
          {about.build && (
            <div className="text-muted-foreground text-xs">{about.build}</div>
          )}
        </div>
      </div>
      {about.onCheckUpdates && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            className="h-11 md:h-7"
            onClick={about.onCheckUpdates}
          >
            Check for updates
          </Button>
          {about.updateStatus && (
            <span className="text-muted-foreground text-xs">
              {about.updateStatus}
            </span>
          )}
        </div>
      )}
    </Pane>
  );
}
