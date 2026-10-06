import { useEffect, useState } from "react";
import type { Theme } from "../types";

/* Theme: light / dark / follow the OS. Stored locally; .dark on <html> switches the shadcn tokens in the
   consumer's CSS. An inline script in index.html applies it before first paint so there is no white flash.
   State + effect live with the UI (no app data involved). */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("lilos-theme") as Theme) ?? "system",
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    let flipSeq = 0;
    const apply = () => {
      const root = document.documentElement;
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      if (root.classList.contains("dark") === dark) return;
      /* #609: ink/surface colors must snap to the new theme, not fade through
         the old theme's values — every color transition (`transition-all`,
         `transition-colors`, inherited `color` on e.g. ScrollArea) otherwise
         animates across the flip and paints the old theme's ink on the new
         surface for ~150ms (light-theme ink on the dark panel = the
         "invisible" Workbench labels). `lilos-theme-freeze` suppresses every
         transition for the flip frame. */
      const seq = ++flipSeq;
      root.classList.add("lilos-theme-freeze");
      root.classList.toggle("dark", dark);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (seq === flipSeq) root.classList.remove("lilos-theme-freeze");
        }),
      );
    };
    apply();
    localStorage.setItem("lilos-theme", theme);
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
  return [theme, setTheme] as const;
}
