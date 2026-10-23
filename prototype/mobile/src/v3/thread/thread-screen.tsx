import { EmptyState, Page, ThreadView } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { hapticApprove, hapticDeny, hapticSelect } from "../haptics";
import type { RootRoutes } from "../nav";
import { $data, answer, approve, deny, markSeen, sendMessage } from "../store";
import { threadVM } from "./thread-vm";

/* One thread as a conversation. The native stack header carries the back
   chevron and the thread's title; the screen draws the rest. */
export function ThreadContainer({
  navigation,
  route,
}: NativeStackScreenProps<RootRoutes, "Thread">) {
  const d = useStore($data);
  const { threadId } = route.params;
  const thread =
    d.threads.find((t) => t.id === threadId) ??
    d.archivedThreads?.find((t) => t.id === threadId);
  const vm = useMemo(
    () => (thread ? threadVM(d, thread) : undefined),
    [d, thread],
  );
  const title = thread?.title ?? "";
  const unseen = thread?.unseen === true;

  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  // Opening a finished thread is looking at it.
  useEffect(() => {
    if (unseen) markSeen(threadId);
  }, [threadId, unseen]);

  if (!vm)
    return (
      <Page testID="thread-gone">
        <EmptyState title="This thread is gone" />
      </Page>
    );

  return (
    <ThreadView
      thread={vm}
      onSend={(text) => {
        hapticSelect();
        sendMessage(threadId, text);
      }}
      onApprove={(askId) => {
        hapticApprove();
        approve(askId);
      }}
      onDeny={(askId) => {
        hapticDeny();
        deny(askId);
      }}
      onAnswer={(askId, option) => {
        hapticSelect();
        answer(askId, option);
      }}
    />
  );
}
