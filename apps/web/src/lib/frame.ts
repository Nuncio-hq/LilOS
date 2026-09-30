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
}: {
  desktop: boolean;
  focus: boolean;
}): string {
  return [
    "lilos-desktop grid h-dvh grid-cols-1 overflow-hidden text-sm",
    desktop ? "" : "lilos-float",
    focus ? "lilos-focus" : "lg:grid-cols-[264px_minmax(0,1fr)]",
  ]
    .filter(Boolean)
    .join(" ");
}
