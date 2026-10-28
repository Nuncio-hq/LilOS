import { modelCatalogOf } from "@lilos/ui";
import type { ModelPickerExtras } from "@lilos/ui/types";
import { useEffect, useMemo } from "react";
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
import { isDefaultRuntime } from "../v3/runtime-ids";
import {
  openRuntimeScreen,
  refreshRuntimeModels,
  retryRuntimeCatalog,
  runtimeCatalogs,
  runtimeRows,
} from "../v3/runtimes";

const NONE: never[] = [];

/* The engine's model list + the picker's extras (#92): Edit models rides the
   relay-persisted visibility list; Refresh renders only when the engine's
   `models` capability declares `refreshable` (D-#19 — no control without a
   handler). `description` is returned so callers re-render on capability
   changes (every `hasCapability` probe reads it).

   #895: `runtime` is the thread's agent's runtime. A non-default one reads
   ITS catalog through `modelCatalogOf` — the rule the new-chat composer
   uses — and none of Hermes's: no provider groups, no Edit models (Hermes's
   hide list), Refresh re-asks that runtime. A catalog that hasn't landed is
   an empty list (`own: true` lets the composer show the pick read-only). */
export function useModelCatalog(runtime?: string) {
  const engineCatalog = useAtom(engineModels);
  const engineModel = useAtom(engineDefaultModel);
  const engineProvider = useAtom(engineDefaultProvider);
  const providers = useAtom(engineProviders);
  const visibility = useAtom(modelVisibility);
  const description = useAtom(engine.description);
  const rows = useAtom(runtimeRows());
  const cats = useAtom(runtimeCatalogs());
  const own = isDefaultRuntime(runtime) ? undefined : runtime;
  /* #899: an open thread IS this runtime's screen — its mount asks the
     catalog (and profile) even while the adapter sleeps; the ask is what
     lazy-starts it. */
  useEffect(() => (own ? openRuntimeScreen(own) : undefined), [own]);
  const ownCat = own
    ? modelCatalogOf({ runtimes: rows, modelCatalogs: cats }, { runtime: own })
    : undefined;
  const catalog = own ? (ownCat?.options ?? NONE) : engineCatalog;
  /* The screen's own ask, in flight or refused — the composer's chip reads
     "Loading models…" / "Models unavailable" (click retries) until the
     catalog lands, never a model this runtime did not name. A catalog that
     landed empty stays a landed catalog: the read-only model chip (#895)
     still draws. */
  const ownRow = own ? rows?.find((r) => r.id === own) : undefined;
  const catalogState =
    own && !ownCat?.options?.length
      ? (ownRow?.catalogState ?? (ownCat ? undefined : "loading"))
      : undefined;
  const defaultModel = own ? ownCat?.defaultModel : engineModel;
  const defaultProvider = own ? ownCat?.defaultProvider : engineProvider;
  const picker = useMemo<ModelPickerExtras | undefined>(() => {
    if (!catalog.length) return undefined;
    if (own)
      return {
        onRefresh: () =>
          refreshRuntimeModels(own).catch((e) => {
            sayError(describeActionError("Couldn't refresh the model list", e));
            throw e;
          }),
      };
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
  }, [catalog, own, providers, visibility, description]);
  return {
    catalog,
    defaultModel,
    defaultProvider,
    picker,
    description,
    own: own !== undefined,
    catalogState,
    catalogDetail: ownRow?.catalogDetail,
    retryCatalog: own ? () => retryRuntimeCatalog(own) : undefined,
  };
}
