import type { SessionModel } from "@lilos/client-runtime";
import type { Conversation } from "@lilos/contracts/app";
import type { Job } from "@lilos/contracts/engine";
import type { PullRequest } from "@lilos/ui/types";
import { useEffect, useState } from "react";
import { describeActionError, hasCapability } from "../lib/actions";
import { useAtom } from "../lib/hooks";
import { hostEditors, type OsEditor } from "../lib/host";
import { $prs, refreshConversationPrs, watchPrs } from "../lib/prs";
import { relay } from "../lib/runtime";
import { sayError } from "../lib/toast";

/* What a thread's header + Workbench read beyond its messages: the
   engine's background jobs, the session's PRs, and the host's editors. */
export function useThreadAux(
  conv: Conversation | undefined,
  feedSynced: boolean,
  model: SessionModel | undefined,
) {
  const convId = conv?.id;
  const sid = conv?.engineRef;
  const cwd = conv?.cwd;

  /* #179: the Workbench Background tab (D-#19) — `jobs.list` fills the rows
     the event stream can't carry (a job the engine started before a harness
     restart); job.* events keep it live after that. Rendered + Stop only
     when the engine declares `background_jobs`. */
  const jobsCapable = hasCapability("background_jobs");
  const [listedJobs, setListedJobs] = useState<Record<string, Job[]>>({});
  useEffect(() => {
    if (!jobsCapable || !sid || !feedSynced) return;
    let dead = false;
    relay
      .request<{ jobs: Job[] }>("jobs.list", { sessionId: sid })
      .then((r) => {
        if (!dead) setListedJobs((prev) => ({ ...prev, [sid]: r.jobs }));
      })
      /* #423 AC-1: a failed list used to leave the Background tab quietly
         empty — the rows the event stream can't carry just vanished. */
      .catch((e) =>
        sayError(describeActionError("Couldn't load background jobs", e)),
      );
    return () => {
      dead = true;
    };
  }, [jobsCapable, sid, feedSynced]);

  /* #579 AC-1: the open conversation's PRs — one fetch on open +
     `turn.completed` (watchPrs); the Workbench probe's read then wins via
     `probePr` (undefined = it hasn't answered, list fills in). */
  const prsByConv = useAtom($prs);
  const listedPr = convId ? prsByConv[convId]?.[0] : undefined;
  const [probePr, setProbePr] = useState<PullRequest | null | undefined>(
    undefined,
  );
  useEffect(() => {
    setProbePr(undefined);
    if (!convId) return;
    watchPrs();
    void refreshConversationPrs(convId);
  }, [convId]);

  /* A running job ticks its uptime every second. */
  const [, setJobsTick] = useState(0);
  const hasRunningJob =
    (model?.jobs ?? []).some((j) => j.status === "running") ||
    (sid ? (listedJobs[sid] ?? []) : []).some((j) => j.status === "running");
  useEffect(() => {
    if (!hasRunningJob) return;
    const t = setInterval(() => setJobsTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [hasRunningJob]);

  /* Open-in-editor affordance for the session header (issue #110): editors
     the host detected — `null` while unknown or when os.open isn't on this
     host (the badge menu hides entirely then, D-#19); `[]` means os.open
     works but no editor was found (Reveal in Finder only). */
  const [editors, setEditors] = useState<OsEditor[] | null>(null);
  useEffect(() => {
    let off = false;
    setEditors(null);
    if (cwd)
      void hostEditors()
        .then((e) => {
          if (!off) setEditors(e);
        })
        /* A failed probe only hides the badge's editor menu (D-#19) — no
           toast: nothing the user asked for failed. */
        .catch(() => {});
    return () => {
      off = true;
    };
  }, [cwd]);

  return { jobsCapable, listedJobs, listedPr, probePr, setProbePr, editors };
}
