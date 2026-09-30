import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./app";
import { loadConfig } from "./lib/config";
import { watchDesktopChrome, watchDragRegions } from "./lib/desktop";
import { watchDraftPruning } from "./lib/drafts";
import {
  bootError,
  bootRuntime,
  watchAsks,
  watchSessionFeeds,
} from "./lib/runtime";

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
  try {
    const cfg = await loadConfig();
    await bootRuntime(cfg);
    watchSessionFeeds();
    watchAsks();
    watchDraftPruning();
  } catch (e) {
    bootError.set((e as Error).message);
  }
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main();
