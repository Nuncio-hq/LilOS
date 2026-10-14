import type { AppMessage } from "@lilos/contracts/app";
import { parseSlashCommand } from "@lilos/contracts/app";
import type { CommandsExecResult } from "@lilos/contracts/engine";
import { engineErrorCode } from "../engine/client";
import type { HarnessCtx, SessionBinding } from "./ctx";

/**
 * A user send that parses as `/name args` runs the engine's command instead
 * of prompting — the same route the TUI's slash dispatch takes. Returns:
 *  - "settled"  — the command ran; its output/notice is posted, the send is
 *    delivered, nothing prompts.
 *  - "prompt"   — a skill expanded into the prompt the caller runs as the
 *    turn's input (the user's own `/name` row stays what was typed).
 *  - "requeued" — the engine call died in transport; the send went back on
 *    the lane like a prompt that never landed.
 */
export type SlashOutcome =
  | { kind: "settled" }
  | { kind: "prompt"; text: string }
  | { kind: "requeued" };

export function slashFor(
  message: AppMessage,
): { name: string; args: string } | null {
  /* Commands never carry attachments — a `/` send with files stays a
     plain prompt rather than silently dropping the images. */
  if (message.attachments?.length) return null;
  return parseSlashCommand(message.text);
}

export async function execSlashCommand(
  this: HarnessCtx,
  binding: SessionBinding,
  message: AppMessage,
  cmd: { name: string; args: string },
): Promise<SlashOutcome> {
  const conn = this.engine;
  if (!conn) return { kind: "requeued" };
  try {
    const res = await conn.request<CommandsExecResult>(
      "commands.exec",
      {
        sessionId: binding.sessionId,
        name: cmd.name,
        ...(cmd.args ? { args: cmd.args } : {}),
      },
      0,
    );
    /* `send`-directive results carry a notice too (skill scaffold hints,
       "sent as next turn") — surface it even when a prompt expansion wins. */
    if (res.notice && res.outcome === "prompt" && res.prompt)
      await this.postSystem(
        binding,
        res.notice,
        `sys:${binding.conversationId}:${message.id}:cmd-notice`,
      );
    if (res.outcome === "prompt" && res.prompt)
      return { kind: "prompt", text: res.prompt };
    if (res.notice)
      await this.postSystem(
        binding,
        res.notice,
        `sys:${binding.conversationId}:${message.id}:cmd-notice`,
      );
    const output = res.output?.trim();
    if (output) {
      const employeeId = this.employeeIdFor(
        this.conversationFromAtom(binding.conversationId),
      );
      /* The command's answer posts as the employee — it IS the employee's
         engine answering; dedupe on the send that ran it so a redelivery
         can't post it twice. */
      this.relayWrite(`command /${cmd.name} answer`, () =>
        this.opts.relay.request("messages.post", {
          channelId: binding.channelId,
          conversationId: binding.conversationId,
          authorKind: "employee",
          authorId: employeeId,
          text: output,
          dedupeKey: `answer:${binding.conversationId}:${message.id}:command`,
        }),
      );
    }
    this.markDelivered(binding, message);
    return { kind: "settled" };
  } catch (error) {
    if (engineErrorCode(error) !== undefined) {
      /* An engine-side refusal (unknown command, closed session) is an
         answer, not a failure to retry — note it and deliver. */
      const detail = error instanceof Error ? error.message : String(error);
      await this.postSystem(
        binding,
        `/${cmd.name}: ${detail}`,
        `sys:${binding.conversationId}:${message.id}:command-error`,
      );
      this.markDelivered(binding, message);
      return { kind: "settled" };
    }
    /* Transport failure — same re-queue semantics as a prompt that never
       landed: back on the lane, unclaimed, waiting on rebind/drain. */
    const live = this.liveBinding(binding);
    live.consumed.delete(message.id);
    this.unclaimMessage(message);
    if (live !== binding) this.enqueueOrPrompt(live, message);
    else this.insertQueued(binding, message);
    return { kind: "requeued" };
  }
}
