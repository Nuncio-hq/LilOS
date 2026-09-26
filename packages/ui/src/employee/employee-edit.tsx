import { Trash2Icon, UserIcon, XIcon } from "lucide-react";
import { useState } from "react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "../components/ai-elements/confirmation";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Field } from "../dialogs/field";
import { HermesAvatar } from "../shell/avatars";
import type { Employee } from "../types";

/* Edit an employee's company record (display name + role) and remove it from the company.
   Removal is destructive in the app but keeps the engine profile — the confirm copy says so.
   Same overlay convention as HireDialog; Confirmation = AI Elements. */
export function EditEmployeeDialog({
  e,
  onClose,
  onSave,
  onRemove,
}: {
  e: Employee;
  onClose: () => void;
  onSave: (name: string, role: string) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(e.name);
  const [role, setRole] = useState(e.role);
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border bg-background shadow-2xl"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b p-4">
          <HermesAvatar status={e.status} className="size-10" />
          <div className="flex-1">
            <div className="font-semibold">Edit employee</div>
            <div className="text-muted-foreground text-xs">
              Company record only — persona, memory and skills stay in the
              profile.
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        <div className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Display name">
              <Input
                aria-label="Display name"
                value={name}
                onChange={(ev) => setName(ev.target.value)}
              />
            </Field>
            <Field label="Role">
              <Input
                aria-label="Role"
                value={role}
                onChange={(ev) => setRole(ev.target.value)}
              />
            </Field>
          </div>
          <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border bg-muted/30 p-3 text-xs">
            <dt className="text-muted-foreground">Profile</dt>
            <dd className="font-mono">{e.profile}</dd>
            <dt className="text-muted-foreground">Model</dt>
            <dd>{e.model}</dd>
          </dl>
          <div className="rounded-lg border border-destructive/30 p-3">
            <div className="mb-2 font-medium text-xs">Danger zone</div>
            {confirming ? (
              <Confirmation
                state="approval-requested"
                approval={{ id: "remove" }}
              >
                <ConfirmationTitle className="text-xs">
                  Remove {e.name} from the company?
                </ConfirmationTitle>
                <div className="space-y-1 text-muted-foreground text-xs">
                  <div>
                    <span className="font-medium text-foreground">Goes:</span>{" "}
                    the company record, channel memberships, and DMs with{" "}
                    {e.name}.
                  </div>
                  <div>
                    <span className="font-medium text-foreground">Stays:</span>{" "}
                    the engine profile{" "}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                      {e.profile}
                    </code>{" "}
                    — its sessions, memory, and skills.
                  </div>
                </div>
                <ConfirmationRequest>
                  <ConfirmationActions>
                    <ConfirmationAction
                      variant="ghost"
                      onClick={() => setConfirming(false)}
                    >
                      Cancel
                    </ConfirmationAction>
                    <ConfirmationAction
                      variant="destructive"
                      onClick={onRemove}
                    >
                      Remove from company
                    </ConfirmationAction>
                  </ConfirmationActions>
                </ConfirmationRequest>
              </Confirmation>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setConfirming(true)}
              >
                <Trash2Icon />
                Remove from company
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 border-t bg-muted/30 p-3">
          <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <UserIcon className="size-3.5" />@{e.id}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {!confirming && (
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button
              disabled={!name.trim() || confirming}
              onClick={() => onSave(name.trim(), role.trim())}
            >
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
