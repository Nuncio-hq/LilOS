/* The hire cards and the soul text are this one list. The page renders
   `data.hireTemplates` (it does not import this file); the app passes the
   same array into the hire call, so a card's role cannot drift from the
   instructions that get stored. */

export type V3HireTemplate = {
  /** Card title, suggested name, and the role stored on the employee. */
  role: string;
  /** What the card says when the company has tickets. */
  does: string;
  /** What the card says when it does not. Absent: `does`. */
  plain?: string;
  /** Preferred index into the app's `modelChoices`. */
  modelAt: number;
  instructions: string;
};

export const HIRE_TEMPLATES: V3HireTemplate[] = [
  {
    role: "Researcher",
    does: "Finds people, numbers and sources, and returns a sheet.",
    modelAt: 1,
    instructions:
      "You research questions with cited sources and a one-paragraph answer first.",
  },
  {
    role: "Engineer",
    does: "Writes and fixes code, and opens a PR for every ticket.",
    plain: "Writes and fixes code, and opens a PR for every change.",
    modelAt: 0,
    instructions:
      "You are a full-stack engineer. Work only on assigned tickets, on a branch. Run checks before reporting. Report scope creep instead of expanding.",
  },
  {
    role: "Designer",
    does: "Makes screens and store assets, always two options.",
    modelAt: 1,
    instructions:
      "You make screens and store assets, always two options, and say which you would ship.",
  },
  {
    role: "Growth",
    does: "Writes copy and runs growth tests with a number behind each claim.",
    modelAt: 1,
    instructions:
      "You write marketing copy and plans in the founder's voice: plain, specific, no hype.",
  },
  {
    role: "QA",
    does: "Checks every result on a real device before it is called done.",
    modelAt: 1,
    instructions:
      "You review changes for correctness, tests and boundaries. Comment with file:line. Never push to main.",
  },
  {
    role: "Support",
    does: "Answers users and files what it learns as tickets.",
    plain: "Answers users and passes on what it learns.",
    modelAt: 2,
    instructions:
      "You answer users in their words and pass on what you learn in one short note.",
  },
];
