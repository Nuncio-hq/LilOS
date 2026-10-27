/* @lilos/ui — presentational surfaces extracted from the prototype (D-#12).
   Props in, callbacks out: no mock data, no fake engine, no app state. The prototype composes
   these with its mock data + fake engine; apps/web imports the same components. UI domain
   types live in ./types.ts. Not: copying prototype components into apps/web (they drift).
   Vendored shadcn/AI Elements live under
   @lilos/ui/components/ui/* and @lilos/ui/components/ai-elements/* (subpath exports). */

// browser (issue #214)
export { BrowserPanel } from "./browser/browser-panel";
export * from "./browser/browser-types";
// shared agent-chat pieces (steer rows, not-sent tray, composer running state)
export * from "./chat/agent-chat";
export { isHidden } from "./chat/model-visibility";
// conversation (shared by the thread panel and Focus — issue #19)
export * from "./conversation/ask-line";
export { FindBar } from "./conversation/find-bar";
export { setFindSessionOpen } from "./conversation/find-unstub";
export type { PlanAction } from "./conversation/plan-card";
// dialogs
export {
  AddFolderDialog,
  NEW_PROJECT_COPY,
  NEW_PROJECT_PAUSED_COPY,
  suggestProjectKey,
} from "./dialogs/add-folder-dialog";
export { pairingUrl } from "./dialogs/pairing";
// focus mode
export { FocusView } from "./focus/focus-view";
// per-conversation composer drafts (issue #103)
export {
  clearDraftIfSent,
  draftKey,
  draftSendKey,
  dropDrafts,
  getDraft,
  setDraft,
  useDraft,
} from "./lib/drafts";
export * from "./lib/helpers";
// shell
export { StatusBanner } from "./shell/banner";
export { ShortcutsDialog } from "./shell/shortcuts-dialog";
export { StatusDialog } from "./shell/status";
export { type ToastNotice, ToastView } from "./shell/toast-view";
// thread panel
export { ThreadView } from "./thread/thread-view";
export * from "./types";
// UX v3: the calm company (People, Work, Goals; Notion-like). The shell is
// controlled; the vocabulary and lookups below let an app (or the prototype's
// mock engine) build the same view models the pages read.
export {
  HIRE_TEMPLATES,
  type V3HireTemplate,
} from "./v3/hire-templates";
export { V3Banner } from "./v3/v3-banner";
export { STEP_VERB } from "./v3/v3-bits";
export type * from "./v3/v3-data-types";
export {
  FolderAccessBanner,
  FolderAccessStep,
  foldersPhrase,
} from "./v3/v3-folder-access";
export {
  HelperRow,
  HelpersBlock,
  HelpersHint,
  ParentLine,
  ParkLine,
  ThreadLineage,
} from "./v3/v3-helpers";
export {
  agentDisplayName,
  agentNameOf,
  agentOf,
  agentTone,
  boardStatus,
  runtimeLook,
  snoozed,
} from "./v3/v3-model";
export {
  isRecordRoute,
  navFromParams,
  paramsFromNav,
  paramsText,
  step as stepNav,
} from "./v3/v3-nav";
export type * from "./v3/v3-page-types";
export { whenWords } from "./v3/v3-schedule-text";
export {
  SECTION_ORDER,
  sectionedThreads,
  sectionOf,
  settledReason,
  snoozeBack,
  type ThreadSections,
  type V3Section,
} from "./v3/v3-sections";
export { skillSlug } from "./v3/v3-settings-skills";
export { V3Shell } from "./v3/v3-shell";
export type { ThreadPark } from "./v3/v3-thread-menu";
export type * from "./v3/v3-types";
export { EngineProblem, firstRunProblem } from "./v3/v3-welcome-engine";
