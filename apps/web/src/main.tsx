import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { loadConfig } from "./lib/config";
import { watchDesktopChrome, watchDragRegions } from "./lib/desktop";
import { watchDraftPruning } from "./lib/drafts";
import {
  bootError,
  bootRuntime,
  watchAsks,
  watchSessionFeeds,
  watchWorkbenchOpens,
} from "./lib/runtime";
import { startShell } from "./lib/start-shell";
import { App } from "./v3/root";

/* The real app's entry. D-#3 web stack: React 19 + Vite + Tailwind v4 +
   shadcn (base-nova) + AI Elements (mandatory) + nanostores; navigation is
   the v3 hash nav (v3/nav.ts), no router library. Not: Next.js. Its screens
   come from packages/ui, accepted in
   prototype/ first (D-#3: the prototype is the UI source of truth; a UI
   change lands there, the owner accepts it, then it is wired here). Not: UI
   hand-copied into this app. */
async function main() {
  const el = document.getElementById("root");
  if (!el) throw new Error("no #root");
  // #232: under Electron, flip data-desktop/data-fullscreen before first
  // paint so the chrome CSS (inset, drag regions, vibrancy) applies cleanly.
  watchDesktopChrome();
  // #301: keep the OS drag-region map fresh as .lilos-drag strips and their
  // controls mount/move, so a freshly swapped header stays clickable.
  watchDragRegions();
  const root = createRoot(el);
  const render = () =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  await startShell({
    popout: window.lilos?.browser?.isBrowserWindow === true,
    boot: async () => {
      try {
        const cfg = await loadConfig();
        await bootRuntime(cfg);
        watchSessionFeeds();
        watchAsks();
        watchWorkbenchOpens();
        watchDraftPruning();
      } catch (e) {
        bootError.set((e as Error).message);
        throw e;
      }
    },
    render,
  });
}

void main();
