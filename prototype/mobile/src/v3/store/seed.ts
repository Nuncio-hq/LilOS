import type { V3Data, V3Thread, V3Turn, V3Update } from "@lilos/ui/v3-data";
import { V3_DATA } from "../../../../web/src/fake-v3";
import { CEO_THREAD_ID } from "../model";

/** One CEO update as an agent turn in the standing thread: the CEO speaking
    unprompted, so no prompt and no steps. */
export function ceoTurn(n: number, u: Pick<V3Update, "at" | "text">): V3Turn {
  return { n, from: `CEO update at ${u.at}`, took: "—", answer: u.text };
}

/** The CEO's standing thread: a plain chat whose history is the CEO's own
    updates, newest first like every other thread. */
function ceoThread(d: V3Data): V3Thread | undefined {
  const ceo = d.agents.find((a) => a.id === d.ceoId);
  if (!ceo) return undefined;
  const own = d.threads.find((t) => t.agentId === ceo.id && t.folder);
  const mine = d.updates
    .filter((u) => u.by === ceo.id)
    .sort((a, b) => b.at.localeCompare(a.at));
  return {
    id: CEO_THREAD_ID,
    agentId: ceo.id,
    title: ceo.name,
    status: "idle",
    startedAt: mine.at(-1)?.at ?? "09:00",
    minutes: 185,
    model: own?.model ?? ceo.model,
    folder: own?.folder,
    turns: mine.map((u, i) => ceoTurn(mine.length - i, u)),
  };
}

/** The Mac prototype's company plus the CEO's standing thread. A fresh copy
    each call, so a reset really starts over. */
export function seed(): V3Data {
  const d = structuredClone(V3_DATA);
  const ceo = ceoThread(d);
  if (ceo) d.threads.push(ceo);
  return d;
}
