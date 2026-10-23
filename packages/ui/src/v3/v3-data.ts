/* The part of v3 with no React and no DOM: the records, the derivations
   the pages read (who is stuck, what waits, the next run), the hire
   templates and the model-visibility rule. Published as
   `@lilos/ui/v3-data` so the phone (React Native) builds the same view
   models from the same fake company as the Mac (#820). Import nothing here
   that touches React, the DOM or CSS: the phone bundles every line. */

export type {
  FileMention,
  ModelOption,
  ModelProvider,
  ModelVisibility,
  SlashItem,
} from "../types";
export { isHidden, modelKey } from "../chat/model-visibility";
export { HIRE_TEMPLATES, type V3HireTemplate } from "./hire-templates";
export type * from "./v3-data-types";
export * from "./v3-model";
export { whenWords } from "./v3-schedule-text";
export type * from "./v3-types";
