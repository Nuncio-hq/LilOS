/* The thread scroll view's bottom inset: the floating stack at the bottom
   is the composer plus, while a background pill shows, the pill itself and
   the 8px stack gap, the "Can't reach" line while the Mac is unreachable
   (#591), the Not-sent tray while stopped sends park there, and Remove's
   Undo toast while it lives (both #555). The inset must clear the whole
   stack — an inset of composerHeight alone leaves the newest line under
   the pill (#181); a missing tray/toast term overlaps the last row. */
export function threadBottomInset(
  composerHeight: number,
  pillHeight = 0,
  noteHeight = 0,
  trayHeight = 0,
  toastHeight = 0,
): number {
  return (
    composerHeight +
    (pillHeight > 0 ? pillHeight + 8 : 0) +
    (noteHeight > 0 ? noteHeight + 8 : 0) +
    (trayHeight > 0 ? trayHeight + 8 : 0) +
    (toastHeight > 0 ? toastHeight + 8 : 0)
  );
}
