import type { V3Note, V3Skill } from "@lilos/ui"

/* The prototype's company library and each agent's memory files. Believable
   for this mock company, and only here: the real app does not carry them
   yet, so its pages do not draw the sections (D-#19).

   A note and a skill body are markdown. A single newline is still one
   paragraph in the renderer, so two thoughts are separated by a blank line
   (or written as a list). A skill's text is the body and does not repeat
   `about`, which is the description shown above it. */

export const SKILLS: V3Skill[] = [
  {
    id: "planning",
    name: "planning",
    about: "Split a goal into tickets with one owner each.",
    text: "A ticket is small enough to finish in a day.\n\nSay what done looks like in the first line.",
  },
  {
    id: "code-review",
    name: "code-review",
    about: "Read the diff before approving it.",
    text: "Read the diff before you approve it.\n\nComment with file and line. Block on a failing test, a secret, or a change larger than the ticket.",
  },
  {
    id: "weekly-report",
    name: "weekly-report",
    about: "Friday: what shipped, what slipped, what is next.",
    text: "On Friday, write what shipped, what slipped, and what next week is for.\n\nOne paragraph. Numbers, not adjectives.",
  },
  {
    id: "typescript",
    name: "typescript",
    about: "Small typed changes, no new dependency for one call.",
    text: "Prefer a small change a reviewer can read in five minutes.\n\nMatch the types already in the file. Do not add a dependency for one call.",
  },
  {
    id: "playwright",
    name: "playwright",
    about: "Drive the screen the way a person would.",
    text: "A spec opens, clicks, types, and expects.\n\nOne assertion per behaviour. Do not wait on a fixed sleep.",
  },
  {
    id: "git-pr",
    name: "git-pr",
    about: "One ticket, one branch, one pull request.",
    text: "Never push to main.\n\nThe pull request says what changed and how it was checked.",
  },
  {
    id: "ios-simulator",
    name: "ios-simulator",
    about: "Run the flow on the simulator before calling it done.",
    text: "Run the flow on the simulator before you call it done.\n\nSay which device and OS you used.",
  },
  {
    id: "screenshots",
    name: "screenshots",
    about: "Attach a shot of the thing that changed.",
    text: "Attach a screenshot of the result, light and dark when the screen has both.\n\nThe shot shows the thing that changed, not the whole desktop.",
  },
  {
    id: "copywriting",
    name: "copywriting",
    about: "Plain sentences. Every claim has a number.",
    text: "Write the way a person talks. One idea per sentence.\n\nEvery claim needs a number, and the number has to be in the ticket.",
  },
  {
    id: "meta-ads",
    name: "meta-ads",
    about: "Three variants, one variable, no spend without a yes.",
    text: "Three variants, one variable changed.\n\nAsk before any spend. Report spend, clicks, and the winner.",
  },
  {
    id: "x-threads",
    name: "x-threads",
    about: "A series of short posts. The first one stands alone.",
    text: "Write a series of short posts. The first one stands alone.\n\nNo link in the first line.",
  },
  {
    id: "web-research",
    name: "web-research",
    about: "A sheet, with a source on every row.",
    text: "Return a sheet, not a wall of text.\n\nCite every row. If a source might be wrong, say so in the row.",
  },
  {
    id: "creator-vetting",
    name: "creator-vetting",
    about: "Creators in the 5k–50k band, never an invented count.",
    text: "Look for creators with 5k–50k followers.\n\nIf you are not sure the creator is real, say so. Do not invent a follower count.",
  },
  {
    id: "sheets",
    name: "sheets",
    about: "One row per fact, one column per question.",
    text: "The first row is the header.\n\nA cell is a value, not a sentence.",
  },
  {
    id: "figma-export",
    name: "figma-export",
    about: "Export the named frame, at the size asked for.",
    text: "Export the frame the ticket names, at the size it asked for.\n\nName the file after the screen, not \"final\" or \"final-2\".",
  },
  {
    id: "app-store-assets",
    name: "app-store-assets",
    about: "A listing is a name, a subtitle, and real screenshots.",
    text: "A listing needs a name, a subtitle, and screenshots of the real screen.\n\nShow two options.",
  },
  {
    id: "brand-voice",
    name: "brand-voice",
    about: "Plain words. Say what it does in the first line.",
    text: "Plain words. Short sentences. No slogans.\n\nSay what the product does in the first line.",
  },
  {
    id: "incident-notes",
    name: "incident-notes",
    about: "What you saw, when it started, what you already tried.",
    text: "When something breaks, write what you saw, when it started, and what you already tried.\n\nOne note. Do not guess a cause you did not check.",
  },
]

const note = (id: string, name: string, updated: string, text: string): V3Note => ({
  id,
  name,
  updated,
  text,
})

/** Memory files per agent id. Outside workers have none. */
export const AGENT_NOTES: Record<string, V3Note[]> = {
  ceo: [
    note(
      "updates",
      "updates.md",
      "from you, 3 Oct",
      "Oscar reads updates on his phone; keep them under 60 words.\n\nWrite one at 9:00 and one at 12:00. Say what shipped, what is stuck, and what needs a decision.",
    ),
    note(
      "shipping",
      "shipping.md",
      "learned 9 Oct",
      "HeardBack ships on Thursdays; never merge to its main on a Friday.",
    ),
  ],
  builder: [
    note(
      "verify",
      "verify.md",
      "from LIL-77",
      "LilOS tests run with bun run verify; E2E only on ready PRs.\n\nNever push to main. Open a pull request for every ticket.",
    ),
    note(
      "flakes",
      "flakes.md",
      "learned today",
      "ac-544 flakes when the cache paints late.\n\nWait for the fresh read before asserting the file list.",
    ),
  ],
  reviewer: [
    note(
      "devices",
      "devices.md",
      "from HB-12",
      "HeardBack's paywall shows only after the third entry.\n\nCheck a result on a real device or browser before calling it done. Attach screenshots.",
    ),
  ],
  marketer: [
    note(
      "hooks",
      "hooks.md",
      "from HB-9",
      "Hook 2 (“write it before you forget it”) scored best with readers.\n\nKeep it as the control when testing a new line.",
    ),
    note(
      "claims",
      "claims.md",
      "2 Oct",
      "Every claim needs a number behind it.\n\nIf the number is not in the ticket, ask Scout before the copy goes anywhere.",
    ),
  ],
  scout: [
    note(
      "readers",
      "readers.md",
      "from HB-9",
      "HeardBack readers are mostly women 25–40 who journal at night.\n\nThey open the app after 21:00.\n\n- A reminder beats an ad.\n- Cite the row.",
    ),
    note(
      "creators",
      "creators.md",
      "from you, 14 Oct",
      "Oscar wants creators with 5k–50k followers, not bigger.\n\nIf a creator might not be real, say so in the row. Do not drop them silently.",
    ),
    note(
      "sources",
      "sources.md",
      "learned 17 Oct",
      "X search is rate-limited after ~40 queries; use Grok Bot for bulk lookups.\n\nCite every row with a link. Check the ones that matter by hand.",
    ),
  ],
  designer: [
    note(
      "brand",
      "brand.md",
      "from QR-2",
      "QRit's brand colour is #2E78AD; icons stay flat.\n\nShow two options, never one.",
    ),
  ],
}
