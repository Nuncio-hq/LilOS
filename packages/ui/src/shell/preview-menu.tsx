import { FlaskConicalIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

/* Prototype-only scenario switcher: the mock data can't reach states like "harness down"
   on its own, so the sidebar carries a small Preview menu to put the app into them.
   Lives in the sidebar footer; the app owns the scenario value and what each one does. */

export type PreviewScenario =
  | "normal"
  | "first-run"
  | "loading"
  | "reconnecting"
  | "harness-down"
  | "engine-down"
  | "model-error"
  | "sleep"
  | "version-mismatch"
  | "profile-missing";

export const SCENARIOS: { id: PreviewScenario; label: string }[] = [
  { id: "normal", label: "Normal demo" },
  { id: "first-run", label: "First run" },
  { id: "loading", label: "Loading sessions" },
  { id: "reconnecting", label: "Reconnecting to relay" },
  { id: "harness-down", label: "Harness down" },
  { id: "engine-down", label: "Engine down" },
  { id: "model-error", label: "Model error" },
  { id: "sleep", label: "Sleep interrupted" },
  { id: "version-mismatch", label: "Version mismatch" },
  { id: "profile-missing", label: "Profile missing" },
];

export function PreviewMenu({
  scenario,
  realApp,
  onScenario,
  onRealApp,
}: {
  scenario: PreviewScenario;
  realApp: boolean;
  onScenario: (s: PreviewScenario) => void;
  onRealApp: (on: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Preview states"
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          />
        }
      >
        <FlaskConicalIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Preview a state</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={scenario}
            onValueChange={(v) => onScenario(v as PreviewScenario)}
          >
            {SCENARIOS.map((s) => (
              <DropdownMenuRadioItem key={s.id} value={s.id} closeOnClick>
                {s.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={realApp}
          onCheckedChange={(v) => onRealApp(v === true)}
          closeOnClick
        >
          Real app
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
