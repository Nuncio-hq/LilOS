import type { Logger } from "./log";

/**
 * D-#817: Hermes keeps a plugin it already imported. Replacing the files
 * on disk does not change the tools of a live backend — a Mac check still
 * listed the old 20 tools until the process was restarted. When a pass
 * actually copies while this engine is up, restart once no turn is
 * running so the next thread loads the new tools. A copy before the
 * engine starts does not restart: boot awaits that pass, then starts on
 * the new files.
 */
export const PLUGIN_RESTART_LOG =
  "lilos plugin changed; restarting the engine so the next thread loads the new tools";

export interface PluginRestartOptions {
  /** True once `supervisor.start` has been requested. */
  engineStarted: () => boolean;
  /** No binding has a running turn or a prompt already handed over. */
  idle: () => boolean;
  restart: () => void;
  log: Logger;
  /** Recheck interval while a turn is still running. */
  pollMs?: number;
}

export function createPluginRestart(opts: PluginRestartOptions): {
  /** A pass copied the plugin. No-op until the engine has been started. */
  noteCopied: () => void;
  stop: () => void;
} {
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pollMs = opts.pollMs ?? 250;

  const arm = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      kick();
    }, pollMs);
    timer.unref?.();
  };

  const kick = () => {
    if (!pending || !opts.engineStarted()) return;
    if (!opts.idle()) {
      arm();
      return;
    }
    pending = false;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    opts.log.info(PLUGIN_RESTART_LOG);
    opts.restart();
  };

  return {
    noteCopied: () => {
      // Boot's reconcile runs before the engine starts. Those bytes are
      // what the process will import; restarting would only bounce it.
      if (!opts.engineStarted()) return;
      pending = true;
      kick();
    },
    stop: () => {
      pending = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
