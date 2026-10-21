import {
  CEO_SETTING_KEY,
  CeoGraphError,
  CompanySetCeoParams,
} from "@lilos/contracts/app";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * `company.setCeo` (D-#778): one relay operation sets the position and
 * re-points `reportsTo`. Change events are the ones clients already
 * follow — `employee.upserted` per moved row, `settings.changed` for
 * the position — so every surface updates without a new event.
 */
export async function handleCeo(c: RelayCtx): Promise<false | undefined> {
  if (c.method !== "company.setCeo") return false;
  const parsed = CompanySetCeoParams.safeParse(c.params);
  if (!parsed.success) throw badParams(parsed.error.issues);
  let result: Awaited<ReturnType<RelayCtx["store"]["setCeo"]>>;
  try {
    result = await c.store.setCeo(parsed.data.employeeId);
  } catch (error) {
    if (error instanceof CeoGraphError) {
      throw new RpcError(
        JsonRpcCode.invalidParams,
        "invalid_params",
        error.message,
      );
    }
    throw error;
  }
  if (!result) {
    throw new RpcError(JsonRpcCode.notFound, "not_found", "employee not found");
  }
  if (result.changed) {
    for (const employee of result.employees) {
      c.broadcast("employee.upserted", { employee });
    }
    c.broadcast("settings.changed", {
      key: CEO_SETTING_KEY,
      value: result.ceoId,
    });
  }
  c.respond(c.peer, c.id, {
    ceoId: result.ceoId,
    employees: result.employees,
  });
  return;
}
