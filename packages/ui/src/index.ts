/* @lilos/ui — presentational surfaces extracted from the prototype (issue #12).
   Props in, callbacks out: no mock data, no fake engine, no app state. The prototype composes
   these with its mock data + fake engine. Vendored shadcn/AI Elements live under
   @lilos/ui/components/ui/* and @lilos/ui/components/ai-elements/* (subpath exports). */

// shared agent-chat pieces (steer rows, not-sent tray, composer running state)
export * from "./chat/agent-chat";
export { Composer } from "./chat/composer";
export { FocusComposer, ModelLogo, ModelPicker } from "./chat/model-picker";
export { AddFolderDialog } from "./dialogs/add-folder-dialog";
// dialogs
export { Field } from "./dialogs/field";
export { HireDialog } from "./dialogs/hire-dialog";
export { StartWorkDialog } from "./dialogs/start-work-dialog";
export { WorkspacePicker, wsHint } from "./dialogs/workspace-picker";
// employees
export { EmployeeCard, EmployeeHome } from "./employee/employee-home";
export { HireCardInline } from "./feed/hire-card";
// channel feed
export { Body, EventRow, FeedList, Row, Who } from "./feed/row";
export { ThreadSummary } from "./feed/thread-summary";
// focus mode
export { FocusView } from "./focus/focus-view";
export { SessionUsage } from "./focus/session-usage";
export { AgentTurn, PrCard, UserTurn } from "./focus/turns";
export * from "./lib/helpers";
// shell
export { HermesAvatar, HumanAvatar } from "./shell/avatars";
export { ChannelHeader } from "./shell/channel-header";
export { RightPanel, TicketsList } from "./shell/right-panel";
export { Sidebar } from "./shell/sidebar";
export { ThemeToggle } from "./shell/theme-toggle";
export { useTheme } from "./shell/use-theme";

// sidebar
export { ChannelItem, NavItem, Section } from "./sidebar/nav";
// thread panel
export { ReplyCards, ThreadView } from "./thread/thread-view";
export * from "./types";
export type { TreeNode } from "./workbench/artifacts";
export { buildTree, sessionArtifacts } from "./workbench/artifacts";
export type { DiffRow } from "./workbench/diff-view";
export { DiffStat, DiffView, parsePatch } from "./workbench/diff-view";
export { TreeNodes } from "./workbench/file-tree-nodes";
export { PrPanel } from "./workbench/pr-panel";
export { StepRow } from "./workbench/step-row";
// workbench
export { Workbench } from "./workbench/workbench";
export { WorkspaceBadge, WsBadge } from "./workbench/ws-badges";
