import type { ModelOption, ModelVisibility } from "../types";

/* Hide/show models in the picker (Hermes Desktop's "Edit models…", ported as
   an idea from apps/desktop/src/store/model-visibility.ts — MIT, NousResearch).
   One list for every employee, owned by the app. A hidden provider also hides
   the models it adds later, and a model new since the last edit is visible
   (only explicit hides are stored). Plain functions, no React: the phone's
   prototype reads the same rule through `@lilos/ui/v3-data`. */

export const modelKey = (m: Pick<ModelOption, "id" | "provider">) =>
  `${m.provider ?? ""}::${m.id}`;

export function isHidden(m: ModelOption, v?: ModelVisibility): boolean {
  if (!v) return false;
  return (
    (!!m.provider && v.providers.includes(m.provider)) ||
    v.models.includes(modelKey(m))
  );
}
