import { Loader2Icon, PlugIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { HermesAvatar } from "../shell/avatars";
import type { ProfileConnection } from "../types";
import { ConnectBadge } from "./connect-badge";

/* First-run "Connect Hermes to LilOS" step (issue #338 AC-1, gateway #336):
   the one-time approval that lets hired profiles see the app. Rendered as the
   same fixed-overlay card as FirstRun — the app chains it after the setup
   card (FirstRun does when its `connect` prop is passed) and calls onConnect
   once; profile states can update live while it applies. Declining keeps
   chat working — LilOS never deletes a profile. */
export function ConnectStep({
  engine = "Hermes",
  profiles,
  connecting,
  onConnect,
  onLater,
}: {
  /** Engine display name in the title ("Connect Hermes to LilOS"). */
  engine?: string;
  /** The hired profiles the approval connects — states render live. */
  profiles: ProfileConnection[];
  /** True while the approval is being applied — actions stay disabled. */
  connecting?: boolean;
  onConnect: () => void;
  onLater: () => void;
}) {
  const pending = profiles.filter((p) => p.state !== "connected");
  return (
    <div
      data-connect-step
      className="fixed inset-0 z-50 grid place-items-center bg-background/95 p-6"
    >
      <div className="w-full max-w-sm rounded-2xl border bg-background p-6 shadow-2xl">
        <div className="mb-4 grid size-10 place-items-center rounded-xl bg-foreground text-background">
          <PlugIcon className="size-5" />
        </div>
        <h1 className="font-semibold text-xl">Connect {engine} to LilOS</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Connected employees see the app — their DMs, folders, tickets and work
          — and act in it for you; this affects only threads LilOS opens, so
          Hermes Desktop and the <code>hermes</code> CLI stay exactly as they
          are.
        </p>
        <div className="mt-5">
          <div className="mb-1.5 font-medium text-xs">
            Profiles this connects
          </div>
          {profiles.length === 0 ? (
            <p className="rounded-lg border border-dashed p-3 text-muted-foreground text-xs">
              No hired profiles yet — new hires ask from the hire dialog, and
              Settings → Engine can connect them later.
            </p>
          ) : (
            <div className="divide-y rounded-lg border">
              {profiles.map((p) => (
                <div
                  key={p.profile}
                  className="flex items-center gap-2.5 px-3 py-2"
                >
                  <HermesAvatar name={p.employee} className="size-6" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-sm">
                      {p.employee ?? p.profile}
                    </div>
                    <div className="truncate font-mono text-muted-foreground text-xs">
                      {p.profile}
                    </div>
                  </div>
                  <ConnectBadge state={p.state} />
                </div>
              ))}
            </div>
          )}
        </div>
        {pending.length > 0 && (
          <div className="mt-6 flex items-center gap-2">
            <Button
              disabled={connecting}
              onClick={onConnect}
              className="flex-1"
            >
              {connecting ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <PlugIcon />
              )}
              {connecting ? "Connecting…" : "Connect"}
            </Button>
          </div>
        )}
        <button
          type="button"
          onClick={onLater}
          disabled={connecting}
          className="mt-3 w-full text-center text-muted-foreground text-xs hover:text-foreground disabled:opacity-50"
        >
          Later
        </button>
      </div>
    </div>
  );
}
