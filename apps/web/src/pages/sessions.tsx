/**
 * /sessions — every session across employees, grouped Needs you / Running /
 * Recently finished. Data is the shared conversationSummaries atom plus the
 * watched session models/signals; seq-synced `conversation.updated` events
 * keep it live with no polling and a reconnect resyncs it whole.
 */
import type { SessionModel } from "@lilos/client-runtime";
import type { SessionGroups, SessionRowVm } from "@lilos/ui";
import { SessionsHome } from "@lilos/ui";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useAtom } from "../lib/hooks";
import { clock } from "../lib/mapping";
import {
  navOpen,
  openConversation,
  relay,
  sessionModels,
  sessionSignals,
} from "../lib/runtime";
import { sessionRows } from "../lib/sessions";

export function SessionsPage() {
  const navigate = useNavigate();
  const summaries = useAtom(relay.conversationSummaries);
  const channels = useAtom(relay.channels);
  const employees = useAtom(relay.employees);
  const models = useAtom(sessionModels) as Record<string, SessionModel>;
  const signals = useAtom(sessionSignals);
  const open = useAtom(openConversation);

  const groups: SessionGroups = useMemo(
    () =>
      sessionRows({
        summaries,
        channels,
        employees,
        models,
        signals,
        formatTime: clock,
      }),
    [summaries, channels, employees, models, signals],
  );

  return (
    <SessionsHome
      groups={groups}
      activeId={open ?? undefined}
      onNav={() => navOpen.set(true)}
      onOpen={(row: SessionRowVm) =>
        void navigate({
          to: "/dm/$employeeId/$conversationId",
          params: {
            employeeId: row.employeeId,
            conversationId: row.id,
          },
        })
      }
    />
  );
}
