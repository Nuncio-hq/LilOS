import { UpdatesPostParams } from "@lilos/contracts/app";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Company updates (D-#777). Listing is any helloed peer — Home and Inbox
 * read it. Posting is the host: the CEO tool stamps the employee, or LilOS
 * posts a system note with no author id. A named ticket or goal must exist.
 */
export async function handleUpdates(c: RelayCtx): Promise<false | undefined> {
  const { method, params, store, broadcast } = c;
  switch (method) {
    case "updates.list": {
      c.respond(c.peer, c.id, { updates: await store.listUpdates() });
      return;
    }
    case "updates.post": {
      if (!c.isHost(c.peer)) {
        throw new RpcError(
          JsonRpcCode.forbidden,
          "forbidden",
          "only the registered engine host may post an update",
        );
      }
      const parsed = UpdatesPostParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const authorKind = parsed.data.authorKind ?? "employee";
      if (authorKind === "employee" && !parsed.data.authorId) {
        throw new RpcError(
          JsonRpcCode.invalidParams,
          "invalid_params",
          "authorId is required for an employee update",
        );
      }
      if (authorKind === "system" && parsed.data.authorId) {
        throw new RpcError(
          JsonRpcCode.invalidParams,
          "invalid_params",
          "a system update has no authorId",
        );
      }
      if (authorKind === "employee") {
        const employees = await store.listEmployees();
        if (!employees.some((e) => e.id === parsed.data.authorId)) {
          throw new RpcError(
            JsonRpcCode.notFound,
            "not_found",
            "employee not found",
          );
        }
      }
      if (
        parsed.data.ticketId &&
        !(await store.getTicket(parsed.data.ticketId))
      ) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "ticket not found",
        );
      }
      if (parsed.data.goalId) {
        const goals = await store.listGoals();
        if (!goals.some((g) => g.id === parsed.data.goalId)) {
          throw new RpcError(
            JsonRpcCode.notFound,
            "not_found",
            "goal not found",
          );
        }
      }
      const update = await store.postUpdate({
        kind: parsed.data.kind,
        text: parsed.data.text,
        ...(parsed.data.ticketId ? { ticketId: parsed.data.ticketId } : {}),
        ...(parsed.data.goalId ? { goalId: parsed.data.goalId } : {}),
        authorKind,
        ...(authorKind === "employee" && parsed.data.authorId
          ? { authorId: parsed.data.authorId }
          : {}),
      });
      broadcast("update.upserted", { update });
      c.respond(c.peer, c.id, { update });
      return;
    }
    default:
      return false;
  }
}
