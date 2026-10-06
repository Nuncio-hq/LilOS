import { Trash2Icon, UserIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { useUiLayerEl } from "../chat/ui-layers";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "../components/ai-elements/confirmation";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Field } from "../dialogs/field";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type {
  Employee,
  EmployeeEditSave,
  EmployeeSaveReply,
  ModelOption,
} from "../types";

/* Edit an employee: display name + role on the company record, plus — when the
   engine's `agents` capability advertises `detail.updatable` — its persona
   (soul), description and default model on the engine profile itself (#123).
   Removal is destructive in the app but keeps the engine profile — the confirm
   copy says so. Same overlay convention as HireDialog; Confirmation = AI Elements. */
export function EditEmployeeDialog({
  e,
  agent,
  updatable = [],
  models = [],
  onClose,
  onSave,
  onRemove,
  error,
}: {
  e: Employee;
  /** Live `agents.describe(e.profile)` — undefined while loading or when the
      engine is unreachable; engine fields only render with it. */
  agent?: { soul?: string; model?: string; description?: string };
  /** `detail.updatable` of the `agents` capability — the only engine fields
      the dialog may show (D-#19). */
  updatable?: string[];
  /** `models.list` rows for the model picker. */
  models?: ModelOption[];
  onClose: () => void;
  // biome-ignore lint/suspicious/noConfusingVoidType: callers may be sync (no engine write) or async savers
  onSave: (edit: EmployeeEditSave) => Promise<EmployeeSaveReply> | void;
  onRemove: () => void;
  /** Rejection reason from the last save/remove attempt — the dialog stays
      open so it can be fixed or cancelled. */
  error?: string;
}) {
  const [name, setName] = useState(e.name);
  const [role, setRole] = useState(e.role);
  const [soul, setSoul] = useState(agent?.soul ?? e.instructions);
  const [model, setModel] = useState(agent?.model ?? e.model);
  const [desc, setDesc] = useState(agent?.description ?? "");
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);

  const canEditEngine = agent !== undefined;
  const showSoul = canEditEngine && updatable.includes("soul");
  const showModel = canEditEngine && updatable.includes("model");
  const showDesc = canEditEngine && updatable.includes("description");
  const engineName = canEditEngine && updatable.includes("name");
  const showEngine = showSoul || showModel || showDesc || engineName;

  const save = async (confirmModel: boolean) => {
    const edit: EmployeeEditSave = { name: name.trim(), role: role.trim() };
    if (engineName && edit.name !== e.name) edit.engineName = true;
    if (showSoul && soul !== (agent?.soul ?? e.instructions)) edit.soul = soul;
    if (showDesc && desc !== (agent?.description ?? ""))
      edit.description = desc;
    if (showModel && model !== (agent?.model ?? e.model)) edit.model = model;
    if (confirmModel) edit.confirmModel = true;
    setPending(true);
    try {
      const r = await onSave(edit);
      const msg =
        r && typeof r === "object" && typeof r.confirmModel === "string"
          ? r.confirmModel
          : null;
      setConfirmMsg(msg);
    } finally {
      setPending(false);
    }
  };

  /* #576: Esc closes this dialog while it is the top-most layer. */
  const layerRef = useUiLayerEl<HTMLDivElement>({ onEscape: onClose });

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Edit employee"
        ref={layerRef}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b p-4">
          <HermesAvatar name={e.name} status={e.status} className="size-10" />
          <div className="flex-1">
            <div className="font-semibold">Edit employee</div>
            <div className="text-muted-foreground text-xs">
              {showEngine
                ? "Company record + engine profile — memory and skills stay untouched."
                : "Company record only — persona, memory and skills stay in the profile."}
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto p-4">
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
          {showDesc && (
            <Field label="Description">
              <Input
                aria-label="Description"
                value={desc}
                onChange={(ev) => setDesc(ev.target.value)}
              />
            </Field>
          )}
          {showSoul && (
            <Field label="Persona (SOUL.md — who this employee is)">
              <Textarea
                aria-label="Persona"
                value={soul}
                onChange={(ev) => setSoul(ev.target.value)}
                className="min-h-24"
              />
            </Field>
          )}
          {showModel &&
            (models.length > 0 ? (
              <Field label="Default model">
                <div className="flex flex-col gap-1.5">
                  {models.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setModel(m.id)}
                      className={cn(
                        "rounded-md border px-2.5 py-1.5 text-left text-xs",
                        model === m.id
                          ? "border-foreground bg-muted font-medium"
                          : "hover:bg-muted/50",
                      )}
                    >
                      {m.name ?? m.id}
                    </button>
                  ))}
                </div>
              </Field>
            ) : (
              <Field label="Default model">
                <Input
                  aria-label="Default model"
                  value={model}
                  onChange={(ev) => setModel(ev.target.value)}
                />
              </Field>
            ))}
          {showEngine && (
            <div className="rounded-lg border bg-muted/30 p-3 text-muted-foreground text-xs">
              Applies to new chats — a chat already running keeps the persona
              and model it started with. The per-chat model picker still
              overrides the default.
            </div>
          )}
          {updatable.length > 0 && !canEditEngine && (
            <div className="rounded-lg border bg-muted/30 p-3 text-muted-foreground text-xs">
              Persona and model can't be loaded — the engine is unreachable.
            </div>
          )}
          {!showEngine && updatable.length === 0 && (
            <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border bg-muted/30 p-3 text-xs">
              <dt className="text-muted-foreground">Profile</dt>
              <dd className="font-mono">{e.profile}</dd>
              <dt className="text-muted-foreground">Model</dt>
              <dd>{models?.find((m) => m.id === e.model)?.name ?? e.model}</dd>
            </dl>
          )}
          {confirmMsg && (
            <Confirmation state="approval-requested" approval={{ id: "model" }}>
              <ConfirmationTitle className="text-xs">
                The engine asks before pinning this model
              </ConfirmationTitle>
              <div className="text-muted-foreground text-xs">{confirmMsg}</div>
              <ConfirmationRequest>
                <ConfirmationActions>
                  <ConfirmationAction
                    variant="ghost"
                    onClick={() => setConfirmMsg(null)}
                  >
                    Cancel
                  </ConfirmationAction>
                  <ConfirmationAction
                    variant="default"
                    onClick={() => void save(true)}
                  >
                    Pin anyway
                  </ConfirmationAction>
                </ConfirmationActions>
              </ConfirmationRequest>
            </Confirmation>
          )}
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
        {error && (
          <div className="border-t bg-red-50/60 px-4 py-2 text-red-800 text-xs dark:bg-red-950/30">
            {error}
          </div>
        )}
        <div className="flex items-center gap-2 border-t bg-muted/30 p-3">
          <span
            className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs"
            title={e.id}
          >
            <UserIcon className="size-3.5 shrink-0" />
            <span className="truncate">@{e.id}</span>
          </span>
          <div className="ml-auto flex items-center gap-2">
            {!confirming && (
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button
              disabled={!name.trim() || confirming || pending}
              onClick={() => void save(false)}
            >
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
