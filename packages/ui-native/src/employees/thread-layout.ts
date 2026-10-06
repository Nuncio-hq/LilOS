/* The thread scroll view's bottom inset: the floating stack at the bottom
   is the composer plus, while a background pill shows, the pill itself and
   the 8px stack gap — and, while the Mac is unreachable, the "Can't reach"
   line (#591). The inset must clear the whole stack — an inset of
   composerHeight alone leaves the newest line under the pill (#181). */
export function threadBottomInset(
  composerHeight: number,
  pillHeight = 0,
  noteHeight = 0,
): number {
  return (
    composerHeight +
    (pillHeight > 0 ? pillHeight + 8 : 0) +
    (noteHeight > 0 ? noteHeight + 8 : 0)
  );
}
