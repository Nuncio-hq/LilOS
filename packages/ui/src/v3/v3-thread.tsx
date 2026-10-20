import { useContext, useEffect, useRef, useState } from "react";
import { Page, Title } from "./v3-bits";
import { PeekWidth } from "./v3-open-record";
import type { V3PageProps } from "./v3-page-types";
import { ChatColumn } from "./v3-thread-chat";
import { WorkPanel, WorkStrip, workTabs } from "./v3-thread-work";
import type { V3Thread } from "./v3-types";
import type { SessionTab } from "./v3-workbench-bits";

/* One thread as a session: the chat is always on screen. Beside the list it
   is the conversation alone with a quiet strip of the work the thread has;
   widened, it is a split: the chat on the left, its work (browser, changes,
   files, terminal…) on the right. */

export function V3ThreadPage(props: V3PageProps & { id: string }) {
  const live = props.data.threads.find((x) => x.id === props.id);
  // A put-away thread still opens (from Threads → All → Archived).
  const t = live ?? props.data.archivedThreads?.find((x) => x.id === props.id);
  if (!t) {
    return (
      <Page>
        <Title>Thread not found</Title>
        <button
          type="button"
          onClick={() => props.go({ page: "threads", view: "live" })}
          className="text-[14px] text-muted-foreground hover:text-foreground"
        >
          ← Back to Threads
        </button>
      </Page>
    );
  }
  return <ThreadBody {...props} t={t} archived={!live} />;
}

function ThreadBody({
  data,
  go,
  act,
  t,
  archived,
}: V3PageProps & { t: V3Thread; archived: boolean }) {
  const peek = useContext(PeekWidth);
  const tabs = workTabs(data, t, !!act.browserOpen);
  const [picked, setPicked] = useState<SessionTab>();
  // Widened, the session opens on the first tab (the browser, when there is
  // one) unless you chose a tab; a tab that has gone (its job ended, say)
  // falls back to it too.
  const first = tabs[0].id;
  const tab = tabs.find((x) => x.id === picked)?.id ?? first;
  const session = peek ? peek.full : picked !== undefined;

  const open = (next: SessionTab) => {
    setPicked(next);
    peek?.setFull(true);
  };
  const close = () => {
    setPicked(undefined);
    peek?.setFull(false);
  };

  const [draft, setDraft] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null);
  // The composer is always mounted; a state change that fills it must land
  // before it takes the focus.
  const [wantFocus, setWantFocus] = useState(false);
  useEffect(() => {
    if (wantFocus) {
      composer.current?.focus();
      setWantFocus(false);
    }
  }, [wantFocus]);
  // Rewind: the files and conversation go back, the message returns to the
  // composer to be edited and sent again. Without the action there is no
  // Rewind on the turns at all.
  const doRewind = act.rewind;
  const rewind = doRewind
    ? (turn: number, text: string) => {
        doRewind(t.id, turn);
        setDraft(text);
        setWantFocus(true);
      }
    : undefined;

  const { markSeen } = act;
  useEffect(() => {
    if (t.unseen) markSeen(t.id);
  }, [t.unseen, t.id, markSeen]);

  // ⌘. stops a working thread, wherever the focus is.
  const working = t.status === "working";
  const { stop } = act;
  useEffect(() => {
    if (!working) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        stop(t.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [working, stop, t.id]);

  const chat = {
    data,
    go,
    act,
    t,
    archived,
    draft,
    onDraft: setDraft,
    composer,
    onRewind: rewind,
  };

  if (!session)
    return (
      <ChatColumn {...chat} session={false}>
        <WorkStrip tabs={tabs} onOpen={open} />
      </ChatColumn>
    );
  return (
    <div className="flex h-full min-h-0">
      <ChatColumn {...chat} session />
      <WorkPanel
        data={data}
        go={go}
        act={act}
        thread={t}
        tabs={tabs}
        tab={tab}
        onTab={setPicked}
        onAsk={() => composer.current?.focus()}
        onClose={close}
      />
    </div>
  );
}
