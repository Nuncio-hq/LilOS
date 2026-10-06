import { EmployeeCard, useUiLayerEl } from "@lilos/ui";
import { Button } from "@lilos/ui/components/ui/button";
import type { Employee, EngineProfile, ModelOption } from "@lilos/ui/types";
import { XIcon } from "lucide-react";

/* #421: the DM header's profile card IS the prototype's shared EmployeeCard —
   the app only hosts it in a dialog shell (Esc + backdrop close, like
   Settings). `onDM` doubles as the close: you're already in the DM.
   `profiles` arrives async (agents.list + describe); undefined renders a
   placeholder instead of a false "Profile missing" flash. */
export function DmProfileCard({
  e,
  profiles,
  engineName,
  ownerName,
  models,
  onEdit,
  onSwitchProfile,
  onClose,
}: {
  e: Employee;
  profiles?: EngineProfile[];
  engineName?: string;
  ownerName: string;
  models?: ModelOption[];
  onEdit?: () => void;
  onSwitchProfile?: (profileId: string) => void;
  onClose: () => void;
}) {
  /* #576: Esc closes this dialog while it is the top-most layer — the
     UI-layer stack replaces the old window keydown so an overlay above it
     keeps Esc and the turn underneath never sees it. */
  const layerRef = useUiLayerEl<HTMLDivElement>({ onEscape: onClose });
  return (
    <div className="fixed inset-0 z-40 grid place-items-center p-6">
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 cursor-default bg-black/30"
        onClick={onClose}
      />
      {/* #504: no border/bg of its own — the card's surface IS the dialog
          surface (the double frame read as a box inside a box). */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${e.name} profile`}
        ref={layerRef}
        className="relative w-full max-w-md rounded-2xl shadow-2xl"
      >
        {profiles === undefined ? (
          <div className="rounded-2xl border bg-background p-6 text-center text-muted-foreground text-sm shadow-2xl">
            Loading profile…
          </div>
        ) : (
          <EmployeeCard
            e={e}
            profiles={profiles}
            engineName={engineName}
            ownerName={ownerName}
            models={models}
            onDM={onClose}
            onEdit={onEdit}
            onSwitchProfile={onSwitchProfile}
          />
        )}
        {/* #504: the visible close — a real button hung on the dialog's
            top-right corner, like the prototype panel's ✕. */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          onClick={onClose}
          className="absolute -top-0.5 -right-0.5 rounded-full border bg-background shadow-md"
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );
}
