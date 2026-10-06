import {
  HelloParams,
  SessionPingParams,
  type WelcomeResult,
} from "@lilos/contracts/app";
import { equalSecret } from "@lilos/contracts/auth";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Moved verbatim out of `../session.ts`'s handle() (#441) — case
 * bodies are byte-identical modulo re-indentation. Returns `false`
 * when `method` belongs to another namespace; `undefined` once handled.
 */
export async function handleHandshake(c: RelayCtx): Promise<false | undefined> {
  const {
    method,
    peer,
    state,
    id,
    params,
    options,
    helloedPeers,
    devicePeers,
    log,
    now,
    protocolVersion,
    relayVersion,
    instanceId,
    recordRejection,
    respond,
  } = c;
  switch (method) {
    case "session.hello": {
      if (state.helloed) {
        /* One hello per connection: re-hello would let a token peer
           retag itself as a device (then a revoke kills the local
           socket) or a device climb back to token scope. */
        throw new RpcError(
          JsonRpcCode.invalidRequest,
          "internal",
          "session.hello already completed on this connection",
        );
      }
      const parsed = HelloParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const hello = parsed.data;
      /** Two auth shapes (#153): the local install token, or a paired
          device's `deviceId` + `credential` exchanged from a grant. */
      if ("token" in hello) {
        /* #568: constant-time compare — `!==` early-exits on the first
           differing byte, a timing oracle for remote token guesses. */
        if (!equalSecret(hello.token, options.token)) {
          log("session.hello rejected: bad token");
          throw new RpcError(
            JsonRpcCode.unauthenticated,
            "unauthenticated",
            "bad auth token",
          );
        }
      } else {
        /* Tag as a device peer BEFORE the auth await: a devices.revoke
           processed while authenticateDevice is in flight must find
           this peer — otherwise a revoked device keeps a live,
           fully-authed socket until it disconnects. Untag on failure. */
        devicePeers.set(peer, hello.deviceId);
        const device = options.pairing
          ? await options.pairing.authenticateDevice(
              hello.deviceId,
              hello.credential,
            )
          : null;
        if (!device) {
          devicePeers.delete(peer);
          log("session.hello rejected: bad device credential");
          throw new RpcError(
            JsonRpcCode.unauthenticated,
            "unauthenticated",
            "bad device credential",
          );
        }
      }
      if (hello.protocolVersion !== protocolVersion) {
        /* Undo the device-branch pre-tag — the hello fails here. */
        devicePeers.delete(peer);
        recordRejection({
          kind: "hello",
          claimed: hello.protocolVersion,
          at: now(),
        });
        log(
          `session.hello rejected: client spoke protocol ${hello.protocolVersion}, relay is ${protocolVersion}`,
        );
        throw new RpcError(
          JsonRpcCode.protocolVersionMismatch,
          "protocol_version_mismatch",
          "protocol version mismatch",
          {
            update:
              hello.protocolVersion > protocolVersion ? "server" : "client",
            clientVersion: hello.protocolVersion,
            serverVersion: protocolVersion,
          },
        );
      }
      state.helloed = true;
      helloedPeers.add(peer);
      log(
        `session.hello accepted (client ${hello.client?.name ?? "app"} ${hello.client?.version ?? ""})`.trim(),
      );
      const { host } = c;
      const welcome: WelcomeResult = {
        protocolVersion,
        relayVersion,
        instanceId,
        engineHost: {
          connected: host !== null,
          state: host?.engine?.state,
          detail: host?.engine?.detail,
          capabilities: host?.status?.capabilities,
          models: host?.status?.models,
          providers: host?.status?.providers,
          defaultModel: host?.status?.defaultModel,
          defaultProvider: host?.status?.defaultProvider,
        },
      };
      respond(peer, id, welcome);
      return;
    }
    case "session.ping": {
      const parsed = SessionPingParams.safeParse(params ?? {});
      if (!parsed.success) throw badParams(parsed.error.issues);
      /* #154 keep-vs-replace probe: the mobile supervisor pings the live
         socket on foreground before deciding to replace it. Answers the
         run identity so a probe across a relay restart also catches the
         instanceId change. */
      respond(peer, id, { ok: true, instanceId });
      return;
    }
    default:
      return false;
  }
}
