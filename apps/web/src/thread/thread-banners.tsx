import { StatusBanner } from "@lilos/ui";

/* #423 AC-2: a failed history fetch says so with a retry instead of
   silently showing a shorter thread — the red band #419 introduced, inline
   so it sits in the message column with Retry right after the text in both
   the panel and the session view. */
export function HistoryNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <StatusBanner
      tone="red"
      inline
      action={{ label: "Retry", onClick: onRetry }}
    >
      Couldn't load this thread's history — earlier messages may be missing.
    </StatusBanner>
  );
}

/* #134 AC-3: a transport without `rewind` (ACP) still restored the files —
   the agent's memory kept the dropped messages, so offer a fresh thread.
   No `onStartFresh` (the host can't open the new thread) → no button. */
export function FilesOnlyBanner({
  filesRestored,
  onStartFresh,
}: {
  filesRestored: boolean;
  onStartFresh?: () => void;
}) {
  return (
    <StatusBanner
      tone="amber"
      action={
        onStartFresh
          ? { label: "Start a new thread from here", onClick: onStartFresh }
          : undefined
      }
    >
      {filesRestored
        ? "Files restored to the earlier checkpoint — but this "
        : "The folder kept its current state (no checkpoint stored) — and this "}
      thread's transport can't rewind the agent's memory: it still remembers the
      dropped messages.
    </StatusBanner>
  );
}
