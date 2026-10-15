import {
  BellIcon,
  CpuIcon,
  KeyboardIcon,
  MonitorIcon,
  MoonIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  SunIcon,
  UserIcon,
  ZapIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import type { Theme } from "../types";
import { RUNTIME_NAME, RuntimeIcon, type V2Runtime } from "./v2-runtime";

type Section = "you" | "runtimes" | "access" | "alerts" | "keys";

const NAV: { id: Section; label: string; icon: typeof UserIcon }[] = [
  { id: "you", label: "You", icon: UserIcon },
  { id: "runtimes", label: "Runtimes", icon: CpuIcon },
  { id: "access", label: "Access", icon: ShieldCheckIcon },
  { id: "alerts", label: "Alerts", icon: BellIcon },
  { id: "keys", label: "Keys", icon: KeyboardIcon },
];

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors",
        on ? "bg-foreground" : "bg-foreground/15",
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] left-[3px] size-4 rounded-full bg-background shadow-sm transition-transform duration-200",
          on && "translate-x-4",
        )}
      />
    </button>
  );
}

/* One settings row: icon, a short label, the control on the right. */
function Row({
  icon,
  label,
  hint,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-4 py-2">
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px]">{label}</div>
        {hint && (
          <div className="text-[12px] text-muted-foreground">{hint}</div>
        )}
      </div>
      {children}
    </div>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-foreground/[0.06] overflow-hidden rounded-2xl ring-1 ring-foreground/[0.07]">
      {children}
    </div>
  );
}

const RUNTIME_ROWS: {
  id: V2Runtime;
  state: "on" | "off" | "soon";
  detail: string;
}[] = [
  { id: "hermes", state: "on", detail: "v0.21.7 · 5 agents" },
  { id: "claude-code", state: "soon", detail: "Agent SDK" },
  { id: "codex", state: "soon", detail: "app-server" },
  { id: "grok-bot", state: "soon", detail: "grokbot-core" },
  { id: "muse", state: "soon", detail: "Muse SDK" },
];

/* v2 settings: five short sections, each a list of icon rows with one
   control. Runtimes show as logos with a status dot. */
export function V2Settings({
  name,
  theme,
  onTheme,
}: {
  name: string;
  theme: Theme;
  onTheme: (t: Theme) => void;
}) {
  const [section, setSection] = useState<Section>("you");
  const [flags, setFlags] = useState({
    askRisky: true,
    fullAccess: false,
    phone: true,
    quietAtMac: true,
    sound: false,
  });
  const flip = (k: keyof typeof flags) => (v: boolean) =>
    setFlags((f) => ({ ...f, [k]: v }));
  return (
    <main className="lilos-v2-main flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="lilos-drag flex h-[52px] shrink-0 items-center px-6">
        <h1 className="font-semibold text-[14px]">Settings</h1>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="w-48 shrink-0 px-3 pt-2">
          {NAV.map((n) => {
            const Icon = n.icon;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => setSection(n.id)}
                aria-current={section === n.id ? "page" : undefined}
                className={cn(
                  "flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors",
                  section === n.id
                    ? "bg-foreground/[0.07] font-medium text-foreground"
                    : "text-foreground/80 hover:bg-foreground/[0.04]",
                )}
              >
                <Icon className="size-4 text-muted-foreground" />
                {n.label}
              </button>
            );
          })}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[36rem] flex-col gap-4 px-8 pt-2 pb-12">
            {section === "you" && (
              <Group>
                <Row icon={<UserIcon />} label="Name">
                  <span className="text-[13px] text-muted-foreground">
                    {name}
                  </span>
                </Row>
                <Row icon={<SunIcon />} label="Theme">
                  <div className="flex rounded-full bg-foreground/[0.06] p-0.5">
                    {(
                      [
                        ["light", SunIcon],
                        ["dark", MoonIcon],
                        ["system", MonitorIcon],
                      ] as const
                    ).map(([t, Icon]) => (
                      <button
                        key={t}
                        type="button"
                        aria-label={t}
                        aria-pressed={theme === t}
                        onClick={() => onTheme(t)}
                        className={cn(
                          "grid h-7 w-9 place-items-center rounded-full transition-colors",
                          theme === t
                            ? "bg-background shadow-sm"
                            : "text-muted-foreground",
                        )}
                      >
                        <Icon className="size-3.5" />
                      </button>
                    ))}
                  </div>
                </Row>
              </Group>
            )}

            {section === "runtimes" && (
              <Group>
                {RUNTIME_ROWS.map((r) => (
                  <div
                    key={r.id}
                    className="flex min-h-14 items-center gap-3 px-4 py-2"
                  >
                    <RuntimeIcon runtime={r.id} className="size-8 rounded-lg" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-[13.5px]">
                        {RUNTIME_NAME[r.id]}
                      </div>
                      <div className="text-[12px] text-muted-foreground">
                        {r.detail}
                      </div>
                    </div>
                    {r.state === "on" ? (
                      <span className="flex items-center gap-1.5 text-[12px] text-emerald-600 dark:text-emerald-400">
                        <span className="size-1.5 rounded-full bg-emerald-500" />
                        On
                      </span>
                    ) : (
                      <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-muted-foreground">
                        Soon
                      </span>
                    )}
                  </div>
                ))}
              </Group>
            )}

            {section === "access" && (
              <Group>
                <Row
                  icon={<ShieldCheckIcon />}
                  label="Ask before risky actions"
                  hint="Money, sending out, deleting"
                >
                  <Toggle
                    on={flags.askRisky}
                    onChange={flip("askRisky")}
                    label="Ask before risky actions"
                  />
                </Row>
                <Row
                  icon={<ZapIcon />}
                  label="Full access"
                  hint="Agents never ask"
                >
                  <Toggle
                    on={flags.fullAccess}
                    onChange={flip("fullAccess")}
                    label="Full access"
                  />
                </Row>
              </Group>
            )}

            {section === "alerts" && (
              <Group>
                <Row icon={<SmartphoneIcon />} label="Phone">
                  <Toggle
                    on={flags.phone}
                    onChange={flip("phone")}
                    label="Phone alerts"
                  />
                </Row>
                <Row icon={<MonitorIcon />} label="Quiet phone at the Mac">
                  <Toggle
                    on={flags.quietAtMac}
                    onChange={flip("quietAtMac")}
                    label="Quiet phone at the Mac"
                  />
                </Row>
                <Row icon={<BellIcon />} label="Sound">
                  <Toggle
                    on={flags.sound}
                    onChange={flip("sound")}
                    label="Sound"
                  />
                </Row>
              </Group>
            )}

            {section === "keys" && (
              <Group>
                {(
                  [
                    ["Search", "⌘K"],
                    ["New thread", "⌘N"],
                    ["Needs you", "⌘J"],
                    ["Stop", "⌘."],
                    ["Settings", "⌘,"],
                  ] as const
                ).map(([label, keys]) => (
                  <div
                    key={label}
                    className="flex h-11 items-center px-4 text-[13.5px]"
                  >
                    <span className="flex-1">{label}</span>
                    <kbd className="rounded-md bg-foreground/[0.06] px-2 py-0.5 font-sans text-[12px] text-foreground/80">
                      {keys}
                    </kbd>
                  </div>
                ))}
              </Group>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
