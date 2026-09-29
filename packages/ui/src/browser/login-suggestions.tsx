import { KeyRoundIcon } from "lucide-react";
import type { SavedLogin } from "./browser-types";

/* The saved-login dropdown the browser shows under a focused sign-in field
   (issue #214 AC-7). It lists usernames only: the password is filled by the
   browser on the user's pick and never appears in the page's view model, so no
   agent tool can read it (#218). */
export function LoginSuggestions({
  site,
  logins,
  onPick,
  onManage,
}: {
  site: string;
  logins: SavedLogin[];
  onPick: (id: string) => void;
  onManage?: () => void;
}) {
  if (logins.length === 0) return null;
  return (
    <div
      data-login-suggestions
      className="w-72 overflow-hidden rounded-xl border bg-popover text-[13px] text-popover-foreground shadow-xl"
    >
      <div className="px-3 pt-2 pb-1 text-muted-foreground text-xs">
        Saved for {site}
      </div>
      {logins.map((l) => (
        <button
          key={l.id}
          data-login={l.id}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(l.id)}
          className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-accent"
        >
          <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{l.username}</span>
          <span className="text-muted-foreground tracking-widest">
            ••••••••
          </span>
        </button>
      ))}
      {onManage && (
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={onManage}
          className="w-full border-t px-3 py-2 text-left text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
        >
          Manage passwords…
        </button>
      )}
    </div>
  );
}
