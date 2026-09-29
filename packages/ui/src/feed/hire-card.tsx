import { UserPlusIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { HermesAvatar } from "../shell/avatars";
import type { EmpFn, HireDraft } from "../types";

/* The hire-proposal card an employee posts in a channel. Only the signed-in
   human can approve — `me` carries their display name (#118). */
export function HireCardInline({
  draft,
  by,
  emp,
  me,
  done,
  onReview,
  onReject,
}: {
  draft: HireDraft;
  by: string;
  emp: EmpFn;
  /** The signed-in human's display name — "only {me} can approve". */
  me: string;
  done?: string;
  onReview: () => void;
  onReject: () => void;
}) {
  return (
    <div className="mt-1 w-full max-w-xl overflow-hidden rounded-lg border border-violet-300">
      <div className="flex items-center gap-2 bg-violet-50 px-3 py-2 font-medium text-violet-900 text-xs">
        <UserPlusIcon className="size-3.5" />
        {done ?? `${emp(by)?.name} proposes a hire · only ${me} can approve`}
      </div>
      {!done && (
        <div className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <HermesAvatar name={draft.name} className="size-8" />
            <div>
              <div className="font-semibold">{draft.name}</div>
              <div className="text-muted-foreground text-xs">
                {draft.role} · {draft.model}
              </div>
            </div>
          </div>
          <p className="line-clamp-2 text-muted-foreground text-xs">
            {draft.instructions}
          </p>
          <div className="flex gap-1.5">
            <Button size="sm" onClick={onReview}>
              Review & hire
            </Button>
            <Button size="sm" variant="ghost" onClick={onReject}>
              Decline
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
