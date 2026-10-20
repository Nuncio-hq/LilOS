import type { AppMessage, Conversation } from "@lilos/contracts/app";
import type { AttachedFile } from "@lilos/ui/types";
import { useEffect, useState } from "react";
import { hydrateAttachments } from "../lib/attachments";
import { useAtom } from "../lib/hooks";
import { beginRewind, filesOnlyBanner, rewindUndone } from "../lib/rewind";

/* #134 + #578: Rewind applies visually the moment it clicks — rows
   at/after the picked message hide (rewindDrops), the target's text and
   attachments reseed the composer (AC-4) — while a 10 s Undo toast runs.
   The real `conversations.rewind` commit (files + engine checkpoints)
   fires when the window closes; Undo — or a commit failure — restores
   everything. On a transport without `rewind` (ACP) the commit surfaces
   the files-only banner (AC-3). The files-only banner and the undo window
   live in lib/rewind atoms — the commit lands after the 10 s window,
   possibly after the surface remounted. */
export function useThreadRewind(
  conversationId: string | undefined,
  pool: AppMessage[],
  threadDraft: string,
  setThreadDraft: (v: string) => void,
) {
  /* #134: rewound message attachments reseeded into the composer (AC-4). */
  const [seedFiles, setSeedFiles] = useState<AttachedFile[] | undefined>();
  const filesOnly = useAtom(filesOnlyBanner);
  const [seedConv, setSeedConv] = useState<string | undefined>();
  /* Both clear when the open session changes — the render-time reset keeps
     them from leaking into the next thread. Only a different open
     conversation resets — a transient `undefined` while summaries refetch
     (e.g. right after conversation.rewound) must not clobber a composer
     seed that's mid-flight. */
  if (conversationId && conversationId !== seedConv) {
    setSeedConv(conversationId);
    setSeedFiles(undefined);
    filesOnlyBanner.set(null);
  }

  /* #578: Undo (or a failed commit) restores the pre-rewind draft and drops
     the reseeded attachment chips — the composer state lives here, the
     signal in lib/rewind. */
  const undone = useAtom(rewindUndone);
  useEffect(() => {
    if (!undone) return;
    rewindUndone.set(null);
    setSeedFiles(undefined);
    if (undone.conversationId === conversationId)
      setThreadDraft(undone.draftBefore);
  }, [undone, conversationId, setThreadDraft]);

  const rewindTo = (conv: Conversation, messageId: string) => {
    const target = pool.find((m) => m.id === messageId);
    if (!target) return;
    /* Capture the about-to-drop message ids — the engine-feed turns they
       prompted would otherwise re-append as rich cards after the thread
       drops the relay rows (mergeTurns). */
    const doomed = pool.filter(
      (m) => m.conversationId === conv.id && m.seq >= target.seq,
    );
    beginRewind(
      {
        conversationId: conv.id,
        messageId,
        draftBefore: threadDraft,
      },
      {
        fromSeq: target.seq,
        ids: doomed.map((m) => m.id),
        texts: doomed
          .filter((m) => m.authorKind === "employee")
          .map((m) => m.text.trim()),
      },
    );
    setThreadDraft(target.text);
    void hydrateAttachments(target.attachments).then((files) => {
      if (files.length) setSeedFiles(files);
    });
  };

  return {
    seedFiles,
    clearSeed: () => setSeedFiles(undefined),
    filesOnly,
    rewindTo,
  };
}
