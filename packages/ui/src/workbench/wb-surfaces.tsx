import { RefreshCcwIcon } from "lucide-react";
import { Shimmer } from "../components/ai-elements/shimmer";
import {
  Terminal,
  TerminalActions,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from "../components/ai-elements/terminal";
import {
  WebPreview,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
} from "../components/ai-elements/web-preview";
import { Quiet, WbBtn } from "./wb-bits";

/* Terminal and Preview without live harness surfaces (the prototype / a
   thread with no host): the transcript the steps already carried, and an
   honest "no dev server" line. With surfaces wired, live.tsx renders them. */

export function StepTerminal({
  output,
  running,
  cwd,
  readOnly,
}: {
  output: string;
  running: boolean;
  cwd: string;
  readOnly: boolean;
}) {
  return (
    <Terminal
      output={output || "\u001b[90mNo commands yet in this thread.\u001b[0m"}
      isStreaming={running}
      className="min-h-0 flex-1 rounded-none border-0"
    >
      <TerminalHeader className="py-1.5">
        <TerminalTitle className="text-xs">
          <span className="font-mono">{cwd}</span>
          {readOnly && (
            <span className="rounded bg-zinc-800 px-1 text-[10px]">
              read-only
            </span>
          )}
        </TerminalTitle>
        <div className="flex items-center gap-1">
          <TerminalStatus>
            <Shimmer as="span" duration={1}>
              running
            </Shimmer>
          </TerminalStatus>
          <TerminalActions>
            <TerminalCopyButton />
          </TerminalActions>
        </div>
      </TerminalHeader>
      <TerminalContent className="max-h-none min-h-0 flex-1 text-xs" />
    </Terminal>
  );
}

export function IdlePreview({
  cwd,
  employeeName,
  onReload,
  onAskDevServer,
}: {
  cwd: string;
  employeeName?: string;
  onReload?: () => void;
  onAskDevServer?: () => void;
}) {
  return (
    <WebPreview
      defaultUrl="http://localhost:5173"
      className="rounded-none border-0"
    >
      <WebPreviewNavigation className="border-[var(--v3-line)] border-b p-1.5">
        {onReload && (
          <WebPreviewNavigationButton tooltip="Reload" onClick={onReload}>
            <RefreshCcwIcon className="size-3.5" />
          </WebPreviewNavigationButton>
        )}
        <WebPreviewUrl />
      </WebPreviewNavigation>
      <div className="space-y-3 px-5 pt-5">
        <Quiet>
          No dev server running in <span className="font-mono">{cwd}</span>.
        </Quiet>
        {onAskDevServer && (
          <WbBtn onClick={onAskDevServer}>
            Ask {employeeName ?? "employee"} to run pnpm dev
          </WbBtn>
        )}
      </div>
    </WebPreview>
  );
}
