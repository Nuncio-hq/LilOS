/* @lilos/ui-native — LilOS mobile UI (React Native). Same rule as @lilos/ui:
   props in, callbacks out; no navigation, stores or native modules beyond
   rendering. Apps (prototype/mobile now, apps/mobile later) wire them. */

export { type MacLink, MacStatusCard } from "./app/mac-status-card";
export { SettingsScreen } from "./app/settings-screen";
export { AppText } from "./components/app-text";
export { LargeTitle, Pill, SectionTitle, StateChip } from "./components/bits";
export { Button } from "./components/button";
export { CompanyChip } from "./components/company-chip";
export { DemoBadge } from "./components/demo-badge";
export { Glass } from "./components/glass";
export { Choice, Row, Section } from "./components/grouped-list";
export { Icon, type IconTone, useThemeColor } from "./components/icon";
export { Orb, type OrbState, type OrbTone } from "./components/orb";
export { ProviderLogo } from "./components/provider-logo";
export {
  hasProviderLogo,
  PROVIDER_LOGOS,
  type ProviderLogoMark,
} from "./components/provider-logos";
export { Screen } from "./components/screen";
export { Mono, StateBlock } from "./components/state-block";
export { ApprovalsSheet } from "./employees/approvals-sheet";
export {
  BackgroundPill,
  BackgroundSheet,
} from "./employees/background-sheet";
export { DmHeaderTitle, EmployeeDmScreen } from "./employees/dm-screen";
export { FolderPickerSheet, pickLabel } from "./employees/folder-picker";
export {
  EmployeesHomeScreen,
  NeedsYouAccessory,
} from "./employees/home-screen";
export { MacFolderBrowser } from "./employees/mac-folder-browser";
export { type MacDetail, MacSheet } from "./employees/mac-sheet";
export {
  effortLabel,
  ModelPickerSheet,
  modelLabel,
} from "./employees/model-picker";
export {
  effortIndex,
  effortOf,
  findModel,
  isModelHidden,
  modelKeyOf,
  nextModelPick,
  pickableModels,
} from "./employees/model-rules";
export {
  type PlanAction,
  PlanCard,
  PlanSheet,
} from "./employees/plan-card";
export {
  type QuestionAnswer,
  QuestionCard,
} from "./employees/question-card";
export { waitingOnQuestion } from "./employees/question-gate";
export {
  SubagentSheet,
  SubagentsCard,
  SubagentsLink,
  SubagentsSheet,
} from "./employees/subagents";
export { ThreadInfoSheet } from "./employees/thread-info-sheet";
export { threadBottomInset } from "./employees/thread-layout";
export { ThreadHeaderTitle, ThreadScreen } from "./employees/thread-screen";
export type {
  AgentEntry,
  Approval,
  BackgroundJobRow,
  ChannelRow,
  ContextUsage,
  EmployeeRow,
  FolderOption,
  MacDir,
  ModelPick,
  ModelProviderRow,
  ModelRow,
  ModelVisibility,
  PlanRow,
  ProjectGroup,
  PullRequestRef,
  QuestionOption,
  SessionState,
  SessionTurn,
  SubagentRow,
  ThreadDetail,
  ThreadEntry,
  ToolStep,
  TurnFailure,
  WbCardEntry,
  WbCardTarget,
  WorkspacePick,
} from "./employees/types";
export { WorkbenchCard } from "./employees/workbench-card";
export {
  type WbDiffFile,
  WbDiffSheet,
} from "./employees/workbench-diff";
export {
  buildPairingUrl,
  CODE_LENGTH,
  formatCode,
  normalizeCode,
  normalizeHost,
  type PairingOffer,
  parsePairingUrl,
} from "./lib/pairing-code";
export { ConnectedScreen } from "./onboarding/connected-screen";
export {
  ConnectingScreen,
  type ConnectingState,
} from "./onboarding/connecting-screen";
export { MacCard } from "./onboarding/mac-card";
export { ManualCodeScreen } from "./onboarding/manual-code-screen";
export { PairIntroScreen } from "./onboarding/pair-intro-screen";
export { ScanScreen } from "./onboarding/scan-screen";
export { WelcomeScreen } from "./onboarding/welcome-screen";
