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
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        theme === "dark" || (theme === "system" && mq.matches),
      );
    apply();
    localStorage.setItem("lilos-theme", theme);
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
  return [theme, setTheme] as const;
}
