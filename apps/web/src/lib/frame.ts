/**
 * The app frame (#246 AC-3). `.lilos-desktop` is the one merged window and is
 * applied in every host; `.lilos-float` adds the floating inset window over
 * the colour field — a plain browser tab. Inside Electron the OS window is
 * already the frame (chrome itself is #232), so there is no wallpaper and no
 * margin: the preload marks the shell via `window.lilos.isDesktop`.
 *
 * `focus` mirrors the prototype's Focus layout: a single column — the sidebar
 * leaves the grid and becomes an overlay. `lilos-focus` marks that state for
 * the desktop chrome rules (#295): with the sidebar hidden, the surface's own
 * header is the leftmost element and takes over the traffic-light reserve.
 */
export function appFrameClass({
  desktop,
  focus,
  browserPanel,
}: {
  desktop: boolean;
  focus: boolean;
  /** The ⌘⇧B browser is docked as a third column (desktop only). */
  browserPanel?: boolean;
}): string {
  return [
    "lilos-desktop grid h-dvh grid-cols-1 overflow-hidden text-sm",
    desktop ? "" : "lilos-float",
    focus
      ? `lilos-focus ${browserPanel ? "lg:grid-cols-[minmax(0,1fr)_auto]" : ""}`
      : browserPanel
        ? "lg:grid-cols-[264px_minmax(0,1fr)_auto]"
        : "lg:grid-cols-[264px_minmax(0,1fr)]",
  ]
    .filter(Boolean)
    .join(" ");
}
