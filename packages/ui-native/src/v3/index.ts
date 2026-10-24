/* The v3 phone screens. Each feature folder exports its screen; shared
   pieces live in kit.tsx / rows.tsx. */

export * from "./company";
export * from "./home";
export {
  Avatar,
  AvatarGrid,
  AvatarRing,
  AvatarStrip,
  CeoChip,
  ClampText,
  CompactRow,
  EmptyState,
  Hairline,
  Module,
  Modules,
  Note,
  Page,
  PersonName,
  ProgressBar,
  type RingPerson,
  Segmented,
  StatTile,
  StatTiles,
  StatusDot,
  StatusLabel,
  T,
  Tag,
} from "./kit";
export * from "./needs";
export { DecisionButtons } from "./rows";
export * from "./search";
export { DOT, INK, RING, STATUS_WORD } from "./status";
export * from "./thread";
export type {
  AskVM,
  Person,
  ResultVM,
  Status,
  ThreadRowVM,
  TicketRowVM,
} from "./types";
export * from "./work";
