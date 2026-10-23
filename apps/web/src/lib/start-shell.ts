/**
 * When the shell paints, relative to the relay boot.
 *
 * The popped-out LilOS Browser window is chrome over a native page slot.
 * `App` already skips the company shell when the preload flag is set, but
 * that check used to run only after `bootRuntime` (`relay.connect()`). The
 * window does not use the relay (v3/root.tsx). ac-215's pop-out poll is
 * expect's default 5s, counted from the mode toggle until
 * `[data-browser=window]` mounts — waiting out the handshake on a busy
 * machine used the whole budget before the chrome existed (#827).
 *
 * The app window still boots before it paints. A failed boot is recorded
 * by the caller and the shell still paints (the error screen).
 */
export async function startShell(opts: {
  popout: boolean;
  boot: () => Promise<void>;
  render: () => void;
}): Promise<void> {
  if (opts.popout) {
    opts.render();
    return;
  }
  try {
    await opts.boot();
  } catch {
    // The caller stores the message on `bootError`.
  }
  opts.render();
}
