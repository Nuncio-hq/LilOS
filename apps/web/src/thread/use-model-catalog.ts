import type { ModelPickerExtras } from "@lilos/ui/types";
import { useMemo } from "react";
import {
  describeActionError,
  refreshModels,
  setModelVisibility,
  toastOnFail,
} from "../lib/actions";
import { useAtom } from "../lib/hooks";
import {
  engine,
  engineDefaultModel,
  engineDefaultProvider,
  engineModels,
  engineProviders,
  modelVisibility,
} from "../lib/runtime";
import { sayError } from "../lib/toast";

/* The engine's model list + the picker's extras (#92): Edit models rides the
   relay-persisted visibility list; Refresh renders only when the engine's
   `models` capability declares `refreshable` (D-#19 — no control without a
   handler). `description` is returned so callers re-render on capability
   changes (every `hasCapability` probe reads it). */
export function useModelCatalog() {
  const catalog = useAtom(engineModels);
  const defaultModel = useAtom(engineDefaultModel);
  const defaultProvider = useAtom(engineDefaultProvider);
  const providers = useAtom(engineProviders);
  const visibility = useAtom(modelVisibility);
  const description = useAtom(engine.description);
  const picker = useMemo<ModelPickerExtras | undefined>(() => {
    if (!catalog.length) return undefined;
    const detail = description?.capabilities.find((c) => c.id === "models")
      ?.detail as { refreshable?: boolean } | undefined;
    return {
      providers: providers.length
        ? providers.map((p) => ({ id: p.id, name: p.name ?? p.id }))
        : undefined,
      visibility,
      onVisibility: (v) =>
        toastOnFail("Couldn't update the model list", setModelVisibility(v)),
      ...(detail?.refreshable === true
        ? {
            /* Toast AND rethrow — the picker must still see the failure so
               its "refreshed" marker stays honest (#423 AC-1). */
            onRefresh: () =>
              refreshModels().catch((e) => {
                sayError(
                  describeActionError("Couldn't refresh the model list", e),
                );
                throw e;
              }),
          }
        : {}),
    };
  }, [catalog, providers, visibility, description]);
  return { catalog, defaultModel, defaultProvider, picker, description };
}
