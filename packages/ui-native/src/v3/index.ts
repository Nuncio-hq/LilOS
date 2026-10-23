/* The v3 phone screens. Each feature folder exports its screen; shared
   pieces live in kit.tsx / rows.tsx. */

export * from "./company";
export * from "./home";
export {
  Avatar,
  CeoChip,
  EmptyState,
  Hairline,
  Note,
  Page,
  PersonName,
  SectionBlock,
  Segmented,
  SerifTitle,
  StatusDot,
  StatusLabel,
  T,
  Tag,
} from "./kit";
export * from "./needs";
export { DecisionButtons, ListRow, ThreadRow, TicketRow } from "./rows";
export * from "./search";
export { DOT, INK, STATUS_VAR, STATUS_WORD } from "./status";
export * from "./thread";
export type {
  AskVM,
  Person,
  Status,
  ThreadRowVM,
  TicketRowVM,
} from "./types";
export * from "./work";
