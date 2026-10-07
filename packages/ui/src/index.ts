/* @lilos/ui — presentational surfaces extracted from the prototype (issue #12).
   Props in, callbacks out: no mock data, no fake engine, no app state. The prototype composes
   these with its mock data + fake engine. Vendored shadcn/AI Elements live under
   @lilos/ui/components/ui/* and @lilos/ui/components/ai-elements/* (subpath exports). */

// browser (issue #214)
export {
  BrowserOmnibox,
  displayUrl,
  hostOf,
  resolveInput,
} from "./browser/browser-omnibox";
export { BrowserPanel, type BrowserPanelProps } from "./browser/browser-panel";
export * from "./browser/browser-types";
export { LoginSuggestions } from "./browser/login-suggestions";
export { AccessPill } from "./chat/access-pill";
// shared agent-chat pieces (steer rows, not-sent tray, composer running state)
export * from "./chat/agent-chat";
export { Composer } from "./chat/composer";
export { FocusComposer } from "./chat/focus-composer";
export {
  choiceFor,
  defaultEffort,
  effortLabel,
  ModelLogo,
  ModelPicker,
  sessionChoice,
} from "./chat/model-picker";
export {
  isHidden,
  ModelVisibilityDialog,
} from "./chat/model-visibility-dialog";
// Esc/key ownership by surface — menu → dialog → panel → Focus (#576)
export { useUiLayer, useUiLayerEl } from "./chat/ui-layers";
// connect to LilOS (issue #338): first-run step, DM notice, shared state badge
export { ConnectBadge } from "./connect/connect-badge";
export { ConnectStep } from "./connect/connect-step";
export { NotConnectedNotice } from "./connect/not-connected-notice";
// conversation (shared by the thread panel and Focus — issue #19)
export { ReplyCards } from "./conversation/cards";
export { FindBar } from "./conversation/find-bar";
export { setFindSessionOpen } from "./conversation/find-unstub";
export { type PlanAction, PlanCard } from "./conversation/plan-card";
export {
  type QuestionAnswer,
  QuestionCard,
} from "./conversation/question-card";
export { TurnSubagents } from "./conversation/subagents";
export {
  AgentTurn,
  AttachmentChips,
  PrCard,
  TurnSteps,
  UserTurn,
} from "./conversation/turns";
export { AddFolderDialog } from "./dialogs/add-folder-dialog";
// dialogs
export { Field } from "./dialogs/field";
export { HireDialog } from "./dialogs/hire-dialog";
export {
  PairPhoneDialog,
  type PairPhoneOffer,
  type PairPhoneState,
  pairingUrl,
} from "./dialogs/pair-phone-dialog";
export { StartWorkDialog } from "./dialogs/start-work-dialog";
export { WorkspacePicker, wsHint } from "./dialogs/workspace-picker";
// employees
export { EditEmployeeDialog } from "./employee/employee-edit";
export { EmployeeCard, EmployeeHome } from "./employee/employee-home";
export { HireCardInline } from "./feed/hire-card";
// channel feed
export { Body, EventRow, FeedList, Row, Who } from "./feed/row";
export { ThreadSummary } from "./feed/thread-summary";
// first run
export { FirstRun, type FirstRunCheck } from "./first-run/first-run";
// focus mode
export { FocusView } from "./focus/focus-view";
export { SessionUsage } from "./focus/session-usage";
// diff-line review comments (issue #108)
export {
  anchorVisible,
  diffCommentsMessage,
  diffSendRoute,
  useDiffComments,
} from "./lib/diff-comments";
// per-conversation composer drafts (issue #103)
export {
  clearDraft,
  clearDraftIfSent,
  draftKey,
  draftSendKey,
  dropDrafts,
  getDraft,
  setDraft,
  useDraft,
} from "./lib/drafts";
export * from "./lib/helpers";
// scheduled tasks (issue #136)
export * from "./schedule/schedule-text";
export { ScheduledTasks } from "./schedule/scheduled-tasks";
export { TaskDialog, type TaskDraft } from "./schedule/task-dialog";
// settings
export { SettingsView } from "./settings/settings-view";
// shell
export { HermesAvatar, HumanAvatar } from "./shell/avatars";
export { StatusBanner } from "./shell/banner";
export { ChannelHeader } from "./shell/channel-header";
export {
  type PreviewScenario,
  PrototypePreviewMenu,
  SCENARIOS,
} from "./shell/preview-menu";
export { type PanelTab, RightPanel, TicketsList } from "./shell/right-panel";
export { Sidebar } from "./shell/sidebar";
export {
  StatusDialog,
  StatusList,
  StatusRow,
  statusSummary,
} from "./shell/status";
export { ThemeToggle } from "./shell/theme-toggle";
export { useTheme } from "./shell/use-theme";

// sidebar
export { ChannelItem, NavItem, Section } from "./sidebar/nav";
// thread panel
export { ThreadView } from "./thread/thread-view";
export * from "./types";
export type { TreeNode } from "./workbench/artifacts";
export { buildTree, sessionArtifacts, turnSteps } from "./workbench/artifacts";
export { BackgroundPanel } from "./workbench/background-panel";
export type { DiffCommentsApi, DiffRow } from "./workbench/diff-view";
export { DiffStat, DiffView, parsePatch } from "./workbench/diff-view";
export { TreeNodes } from "./workbench/file-tree-nodes";
export type { LiveBrowserInput, LiveSurfaces } from "./workbench/live";
export { LivePreview, LiveTerminal } from "./workbench/live";
export { OpenPathButton, OpenPathMenu } from "./workbench/open-path";
export {
  PlanPanel,
  planTodos,
  threadPlans,
} from "./workbench/plan-panel";
export { PrPanel } from "./workbench/pr-panel";
export { StepRow } from "./workbench/step-row";
// workbench
export { Workbench } from "./workbench/workbench";
export { WorkspaceBadge, WsBadge } from "./workbench/ws-badges";
