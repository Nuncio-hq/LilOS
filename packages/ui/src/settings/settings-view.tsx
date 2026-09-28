import {
  ActivityIcon,
  AppWindowIcon,
  BoxesIcon,
  ChevronLeftIcon,
  InfoIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { providerName } from "../chat/model-picker";
import { ModelVisibilityDialog } from "../chat/model-visibility-dialog";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { SettingsSectionId } from "../types";
import {
  type AboutProps,
  AboutSection,
  type ApprovalsProps,
  ApprovalsSection,
  type EditorsProps,
  EditorsSection,
  type GeneralProps,
  GeneralSection,
  type ModelsProps,
  ModelsSection,
  type StatusProps,
  StatusSection,
} from "./sections";

/* Settings screen (issue #139, prototyped in prototype/web before the real app
   wires it in #132): a left list of sections and a right pane, in the same look
   as the other overlays. Props in, callbacks out — every section renders only
   when its props are passed (D-#19), so the app controls exactly which settings
   exist today. On phone width the list shows first and a section opens as a
   drill-in pane with an "All settings" back row — no horizontal scroll. */

const SECTIONS: {
  id: SettingsSectionId;
  label: string;
  icon: typeof UserIcon;
}[] = [
  { id: "general", label: "General", icon: UserIcon },
  { id: "approvals", label: "Approvals", icon: ShieldCheckIcon },
  { id: "editors", label: "Editors", icon: AppWindowIcon },
  { id: "models", label: "Models", icon: BoxesIcon },
  { id: "status", label: "Status", icon: ActivityIcon },
  { id: "about", label: "About", icon: InfoIcon },
];

export function SettingsView({
  onClose,
  general,
  approvals,
  editors,
  models,
  status,
  about,
}: {
  onClose: () => void;
  general?: GeneralProps;
  approvals?: ApprovalsProps;
  editors?: EditorsProps;
  models?: ModelsProps;
  status?: StatusProps;
  about?: AboutProps;
}) {
  const bySection: Record<SettingsSectionId, object | undefined> = {
    general,
    approvals,
    editors,
    models,
    status,
    about,
  };
  const visible = SECTIONS.filter((s) => bySection[s.id] !== undefined);
  const [active, setActive] = useState<SettingsSectionId>(
    visible[0]?.id ?? "general",
  );
  /* Phone layout: the section list fills the screen until a pick opens the
     pane; "All settings" goes back. Desktop always shows both. */
  const [paneOpen, setPaneOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const shown = bySection[active] !== undefined ? active : visible[0]?.id;

  /* Esc closes Settings — except while the nested Models dialog is open (it
     consumes Esc itself; closing the whole screen under it would be a trap). */
  useEffect(() => {
    if (modelsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modelsOpen, onClose]);

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/30 sm:p-6"
      onClick={(e) => {
        /* Backdrop click only — clicks inside the portaled Models dialog
           bubble through the React tree and would otherwise close Settings. */
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex h-dvh w-full flex-col overflow-hidden bg-background sm:h-auto sm:max-h-[85dvh] sm:max-w-3xl sm:rounded-2xl sm:border sm:shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SettingsIcon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 truncate font-semibold">Settings</div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close settings"
            className="ml-auto size-11 md:size-7"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
        <div className="grid min-h-0 flex-1 md:grid-cols-[200px_minmax(0,1fr)]">
          <div
            role="tablist"
            aria-label="Settings sections"
            aria-orientation="vertical"
            className={cn(
              "min-h-0 space-y-0.5 overflow-y-auto p-2 md:border-r md:pt-4",
              paneOpen && "hidden md:block",
            )}
          >
            {visible.map((s) => {
              const Icon = s.icon;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={shown === s.id}
                  onClick={() => {
                    setActive(s.id);
                    setPaneOpen(true);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-3 text-left text-sm hover:bg-muted md:py-2",
                    shown === s.id && "bg-muted font-medium",
                  )}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  {s.label}
                </button>
              );
            })}
          </div>
          <div
            role="tabpanel"
            className={cn(
              "min-h-0 overflow-y-auto overflow-x-hidden",
              paneOpen ? "block" : "hidden md:block",
            )}
          >
            <div className="flex items-center border-b px-2 py-2 md:hidden">
              <Button
                variant="ghost"
                size="sm"
                aria-label="All settings"
                className="h-11"
                onClick={() => setPaneOpen(false)}
              >
                <ChevronLeftIcon />
                Settings
              </Button>
            </div>
            {shown === "general" && general && (
              <GeneralSection general={general} />
            )}
            {shown === "approvals" && approvals && (
              <ApprovalsSection approvals={approvals} />
            )}
            {shown === "editors" && editors && (
              <EditorsSection editors={editors} />
            )}
            {shown === "models" && models && (
              <ModelsSection
                models={models}
                onManage={() => setModelsOpen(true)}
              />
            )}
            {shown === "status" && status && <StatusSection status={status} />}
            {shown === "about" && about && <AboutSection about={about} />}
          </div>
        </div>
      </div>
      {models && (
        <ModelVisibilityDialog
          open={modelsOpen}
          onOpenChange={setModelsOpen}
          models={models.models}
          providers={models.providers}
          providerLabel={
            models.providerLabel ?? ((id) => providerName(id, models.providers))
          }
          visibility={models.visibility}
          onVisibility={models.onVisibility}
        />
      )}
    </div>
  );
}
