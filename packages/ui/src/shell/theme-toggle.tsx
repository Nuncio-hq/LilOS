import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { cn } from "../lib/utils";
import type { Theme } from "../types";

export function ThemeToggle({
  theme,
  setTheme,
}: {
  theme: Theme;
  setTheme: (t: Theme) => void;
}) {
  const opts: [Theme, string, typeof SunIcon][] = [
    ["light", "Light", SunIcon],
    ["dark", "Dark", MoonIcon],
    ["system", "System (follow macOS)", MonitorIcon],
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="ml-auto inline-flex w-fit items-center gap-0.5 rounded-md bg-sidebar-accent p-0.5"
      data-theme-toggle
    >
      {opts.map(([t, label, I]) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={theme === t}
          title={label}
          aria-label={label}
          onClick={() => setTheme(t)}
          data-theme-opt={t}
          className={cn(
            "grid size-11 place-items-center rounded text-foreground md:size-6",
            theme === t && "bg-background shadow-sm dark:bg-white/15",
          )}
        >
          <I className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
