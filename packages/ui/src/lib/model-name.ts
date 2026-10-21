import type { ModelOption } from "../types";

/** The catalog name for a model id. A provider match wins; any named row
    with that id is next, so a session whose provider slug differs from
    the catalog still shows the name other threads show. The raw id is
    only the fallback when the catalog has no named row (D-#777). */
export function catalogModelName(
  id: string | undefined,
  models: readonly ModelOption[] | undefined,
  provider?: string,
): string | undefined {
  if (!id) return undefined;
  const named = (row: ModelOption | undefined) =>
    row?.name ? row.name : undefined;
  const byProvider =
    provider === undefined
      ? undefined
      : models?.find((m) => m.id === id && m.provider === provider);
  return named(byProvider) ?? named(models?.find((m) => m.id === id)) ?? id;
}
