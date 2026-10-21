import { Btn } from "../v3/v3-bits";

/** D-#772: the one card a stuck thread shows in the chat. Stop ends the
    turn; Message puts the cursor in the composer. Either button exists
    only with its handler (D-#19). Red is the stuck status colour. */
export function StuckCard({
  reason,
  onStop,
  onMessage,
}: {
  reason: string;
  onStop?: () => void;
  onMessage?: () => void;
}) {
  return (
    <div data-stuck className="mx-auto w-full max-w-[720px] px-8 pb-3">
      <div className="rounded-[10px] border border-red-300 bg-red-50 px-4 py-3 dark:border-red-400/40 dark:bg-red-400/10">
        <div className="font-medium text-[14px] text-red-700 dark:text-red-300">
          Stuck
        </div>
        <p className="mt-1 text-[14px] text-foreground">{reason}</p>
        {(onStop || onMessage) && (
          <div className="mt-3 flex gap-2">
            {onStop && (
              <Btn small onClick={onStop}>
                Stop
              </Btn>
            )}
            {onMessage && (
              <Btn small onClick={onMessage}>
                Message
              </Btn>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** D-#19: Message exists only when a send can land. `onSend` is that
    handler; the terminal takeover blocks the composer even when it is
    wired. */
export function stuckMessageHandler(
  onSend: unknown,
  focus: () => void,
  blocked = false,
): (() => void) | undefined {
  if (blocked || typeof onSend !== "function") return undefined;
  return focus;
}

/** The composer's box, from the column that holds the card and the box. */
export function focusThreadComposer(root: HTMLElement | null) {
  const box = root?.querySelector("[data-composer] textarea");
  if (box instanceof HTMLTextAreaElement) box.focus();
}
