import type { V3DataActions } from "@lilos/ui"
import { askActions } from "./asks"
import { browserActions } from "./browser"
import { chatActions } from "./chats"
import type { Engine } from "./context"
import { peopleActions } from "./people"
import { phoneActions } from "./phone"
import { planActions } from "./plan"
import { projectActions } from "./projects"
import { scheduleActions } from "./schedules"
import { searchActions } from "./search"
import { settingsActions } from "./settings"

/* The prototype's company engine: each action rewrites the mock records the
   way the real relay would, so the next screen tells the truth. Actions never
   navigate: the page that called one decides where to go next. The areas
   live beside this file, one per part of the product; this only joins them. */
export function makeActions(engine: Engine): V3DataActions {
  return {
    ...askActions(engine),
    ...chatActions(engine),
    ...peopleActions(engine),
    ...planActions(engine),
    ...projectActions(engine),
    ...scheduleActions(engine),
    ...browserActions(engine),
    ...phoneActions(engine),
    ...settingsActions(engine),
    ...searchActions(engine),
  }
}
