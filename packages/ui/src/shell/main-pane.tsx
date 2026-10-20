import type { ReactNode } from "react";

/* A pane's single `<main>` landmark (#660). A host mounts this itself so
   the element outlives a view swap — a pane that remounts goes detached
   mid-measure and reads as "not laid out". `bare` lets a view render its
   contents into that host pane; without it the view supplies its own
   `<main>` (prototype paths unchanged). */
export function MainPane({
  bare,
  children,
}: {
  bare?: boolean;
  children?: ReactNode;
}) {
  return bare ? (
    <>{children}</>
  ) : (
    <main className="lilos-glass flex min-h-0 min-w-0 flex-1 flex-col">
      {children}
    </main>
  );
}
