import { Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Btn } from "./v3-bits";
import { EscLayer, useFocusBack, useFocusOn } from "./v3-keys";
import { threadProjectId } from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import type { V3Project } from "./v3-types";

/* The quiet end of a project's page: stop treating the folder as a project
   (#854). It cannot lose anything — the folder and every thread stay, the
   threads simply file as chats again — but it still asks in place first.
   Afterwards the record is gone, so the page lands on Home. */

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function RemoveProject({
  data,
  go,
  act,
  project,
}: V3PageProps & { project: V3Project }) {
  const [asking, setAsking] = useState(false);
  // The question opens on its safe answer; closing it returns to the trigger.
  const cancelBtn = useFocusOn<HTMLButtonElement>(asking);
  const trigger = useFocusBack<HTMLButtonElement>(asking);
  const [busy, setBusy] = useState(false);
  const remove = act.removeProject;
  if (!remove) return null;

  const threads = [...data.threads, ...(data.archivedThreads ?? [])].filter(
    (t) => threadProjectId(data, t) === project.id,
  ).length;

  const confirm = () => {
    setBusy(true);
    remove(project.id).then(
      () => go({ page: "home" }),
      () => setBusy(false),
    );
  };

  return (
    <div
      data-remove-project
      className="mt-14 border-[var(--v3-line)] border-t pt-4"
    >
      {asking ? (
        <div
          role="group"
          aria-label={`Remove ${project.name} as a project`}
          className="rounded-lg border border-[var(--v3-line)] bg-[var(--v3-soft)] px-4 py-3 text-[13.5px] leading-relaxed"
        >
          <EscLayer onEscape={() => !busy && setAsking(false)} />
          <p className="font-medium text-[14px] text-foreground">
            Remove {project.name} as a project?
          </p>
          <p className="mt-1.5 text-muted-foreground">
            <span className="font-medium text-foreground">Stays:</span> the
            folder{" "}
            <span className="font-mono text-[12.5px] text-foreground">
              {project.folder}
            </span>
            , and {threads > 0 ? count(threads, "thread") : "its threads"} —
            they become chats again.
          </p>
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Goes:</span> the
            project — its name, key and place in the sidebar. Nothing on disk is
            touched.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Btn small primary onClick={busy ? undefined : confirm}>
              {busy ? "Removing…" : "Remove project"}
            </Btn>
            <Btn
              small
              ref={cancelBtn}
              onClick={busy ? undefined : () => setAsking(false)}
            >
              Cancel
            </Btn>
          </div>
        </div>
      ) : (
        <button
          ref={trigger}
          type="button"
          onClick={() => setAsking(true)}
          className="inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-[13px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-red-600 dark:hover:text-red-300 [&_svg]:size-3.5"
        >
          <Trash2Icon />
          Remove project
        </button>
      )}
    </div>
  );
}
