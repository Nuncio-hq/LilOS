/* #872 — the stock engine profile is `default`, and a hire seeds the
   employee's name off it, so the first agent's record reads "Default".
   What a person sees is the runtime that owns it — "Hermes" (D-#761).
   Display only: the stored name and the profile id stay untouched, and a
   name the owner set — anything but the untouched seed — wins. Lives here
   so web and mobile render the same name off the same rule. */
const STOCK_SEED = /^default$/i;

export const agentDisplayName = (a: {
  name: string;
  profile?: string;
  runtime?: string | null;
}): string =>
  a.profile === "default" &&
  (!a.runtime || a.runtime === "hermes") &&
  STOCK_SEED.test(a.name)
    ? "Hermes"
    : a.name;
