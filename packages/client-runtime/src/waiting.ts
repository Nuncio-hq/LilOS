import type { AppMessage } from "@lilos/contracts/app";
import type { SessionModel } from "./turn-model";

/**
 * A user message still waiting behind a running turn (#315): renders in the
 * tray above the composer, never as a reply bubble.
 */
export interface WaitingMessage {
  message: AppMessage;
  /**
   * The harness still holds it — Remove/Edit are offered. An accepted-but-
   * unlanded steer already reached the engine (seq <= deliveredSeq): the row
   * shows, but the actions aren't offered.
   */
  removable: boolean;
}

export interface WaitingResult {
  /** User messages waiting for the engine, oldest first. */
  waiting: WaitingMessage[];
  /**
   * Message ids that must not render as reply rows: waiting items, landed
   * steers (they render once — "Oscar steered …" inside the turn), and
   * parked/removed rows the thread fetch opted back in.
   */
  hiddenIds: Set<string>;
}

/**
 * Which user messages in a conversation are waiting right now (#315) —
 * relay truth, so a reload shows the same tray (deliveredSeq) plus what the
 * running turn already claimed (model refs + landed steers):
 *
 * - `seq > deliveredSeq` → the engine never got it: waiting, removable.
 * - accepted-but-unlanded steer (seq <= deliveredSeq, posted after the live
 *   turn's prompt, not yet in `turn.steers`) → waiting, not removable.
 * - landed steer (`turn.steers` text, paired in order) → consumed: hidden
 *   from replies, not waiting.
 * - a turn's `ref` message → consumed: renders as its own prompt bubble.
 * - `dropped`/`removed`/`rewound` → hidden, never waiting.
 */
export function waitingMessages(
  messages: AppMessage[],
  deliveredSeq: number,
  model: SessionModel | undefined,
): WaitingResult {
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  const seqById = new Map(sorted.map((m) => [m.id, m.seq]));
  const hiddenIds = new Set<string>();
  /* Pair each landed `turn.steers` text to the earliest unpaired user
     message posted after that turn's own prompt — the same text steered
     twice lands on two different rows. */
  for (const turn of model?.turns ?? []) {
    const refSeq = turn.ref ? (seqById.get(turn.ref) ?? -1) : -1;
    for (const text of turn.steers) {
      /* Only delivered rows can have landed — a still-waiting re-send of
         the same text must not be mistaken for the landed steer (it would
         be hidden without ever landing). */
      const hit = sorted.find(
        (m) =>
          m.authorKind === "user" &&
          !hiddenIds.has(m.id) &&
          !m.dropped &&
          !m.removed &&
          !m.rewound &&
          m.seq > refSeq &&
          m.seq <= deliveredSeq &&
          m.text.trim() === text.trim(),
      );
      if (hit) hiddenIds.add(hit.id);
    }
  }
  const consumed = new Set(
    (model?.turns ?? [])
      .map((t) => t.ref)
      .filter((r): r is string => typeof r === "string"),
  );
  /* A live turn anchors the window: messages posted after its prompt are
     waiting even under the watermark (accepted steers sit there). A ref-less
     live turn (engine-initiated leg) anchors at the conversation start. */
  const liveAnchor = model?.live
    ? model.live.ref
      ? (seqById.get(model.live.ref) ?? 0)
      : 0
    : undefined;
  const waiting: WaitingMessage[] = [];
  for (const m of sorted) {
    if (m.authorKind !== "user") continue;
    if (m.dropped || m.removed || m.rewound) {
      hiddenIds.add(m.id);
      continue;
    }
    if (hiddenIds.has(m.id) || consumed.has(m.id)) continue;
    /* Claimed (#377): the harness committed this send to the engine
       pipeline — its prompt is dispatching. It is not "waiting": Remove
       must never be offered on a send that can no longer be reordered, so
       the tray only lists genuinely queued sends. The row renders as its
       own sent bubble until `turn.started` consumes it. */
    if (m.claimed) continue;
    const pending = m.seq > deliveredSeq;
    const acceptedSteer =
      !pending && liveAnchor !== undefined && m.seq > liveAnchor;
    if (pending || acceptedSteer) {
      waiting.push({ message: m, removable: pending });
      hiddenIds.add(m.id);
    }
  }
  return { waiting, hiddenIds };
}
