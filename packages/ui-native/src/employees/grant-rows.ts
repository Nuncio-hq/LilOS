import type { GrantOption } from "./types";

/** #687: the ask card's pill layout as row assignments — grants fill
   left-to-right in pairs and Deny trails the last grant row, so it never
   floats vertically centred between wrapped rows.
   - once + deny            → one row [once, deny]
   - 2 grants + deny        → [g1 g2] / [deny] — deny on its own trailing row
   - 3 grants + deny        → [g1 g2] / [g3 deny] — the 2×2 grid, deny on
     Always's baseline at the trailing edge
   - no deny                → grants in pairs, nothing pinned */
export function grantRows(options: readonly GrantOption[]): GrantOption[][] {
  const grants = options.filter((o) => o !== "deny");
  if (!options.includes("deny")) return grants.length ? pairs(grants) : [];
  if (grants.length <= 1) return [[...grants, "deny"]];
  if (grants.length === 2) return [grants, ["deny"]];
  const rows = pairs(grants);
  rows[rows.length - 1].push("deny");
  return rows;
}

function pairs(list: GrantOption[]): GrantOption[][] {
  const rows: GrantOption[][] = [];
  for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2));
  return rows;
}
