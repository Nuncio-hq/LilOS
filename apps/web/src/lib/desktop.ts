/**
 * Native macOS window chrome (issue #232): under the Electron preload
 * bridge, `<html>` carries `data-desktop` (traffic-light inset, drag
 * regions, sidebar vibrancy) and `data-fullscreen` while the window is in
 * native full screen — where macOS hides the lights, so the sidebar header
 * drops the inset it kept for them. A plain browser tab has no bridge and
 * is left untouched (AC-5). Returns an unsubscribe for tests.
 */
export function watchDesktopChrome(): () => void {
  const bridge = window.lilos;
  if (!bridge?.isDesktop) return () => {};
  const root = document.documentElement;
  root.setAttribute("data-desktop", "");
  const apply = (fullScreen: boolean) => {
    if (fullScreen) root.setAttribute("data-fullscreen", "");
    else root.removeAttribute("data-fullscreen");
  };
  apply(bridge.fullscreen?.current() ?? false);
  const off = bridge.fullscreen?.onChange(apply);
  return () => {
    off?.();
    root.removeAttribute("data-desktop");
    root.removeAttribute("data-fullscreen");
  };
}
