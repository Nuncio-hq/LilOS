import type { ProfileSettings } from "@lilos/contracts/app";
import type { Human, HumanFn } from "@lilos/ui/types";
import { atom } from "nanostores";

/* The signed-in human (this build is single-user). `USER_ID` is the author id
   the relay puts on that person's messages; every surface renders it as one
   identity, never an anonymous "You" (issue #80, AC-1).
   Issue #118: the identity itself is relay-owned domain data — `profile`
   mirrors `relay.settings`; when the store is empty (an install predating
   profile settings, AC-4) the OS user's full name prefills it. */
export const USER_ID = "user";

/** The relay-stored profile, bound to `relay.settings` in runtime.ts. */
export const profile = atom<ProfileSettings>({});
/** The OS account's full name — host.user, fetched once at boot. */
export const osFullName = atom<string | null>(null);

/** Default avatar chip colour until the colour picker lands (#132). */
export const DEFAULT_AVATAR_COLOR = "bg-blue-600";

const firstName = (full: string) => full.trim().split(/\s+/)[0];

/** Effective display name: stored profile > OS full name > "Me". */
export function currentName(): string {
  return profile.get().userName ?? osFullName.get() ?? "Me";
}

export function currentMe(): Human {
  return {
    name: currentName(),
    color: profile.get().avatarColor ?? DEFAULT_AVATAR_COLOR,
  };
}

/** Company label: stored > derived `<first>'s Co` > "My Co". */
export function currentCompany(): string {
  const p = profile.get();
  if (p.companyName) return p.companyName;
  const full = p.userName ?? osFullName.get();
  return full ? `${firstName(full)}'s Co` : "My Co";
}

export const humanFor: HumanFn = (id) =>
  id === USER_ID ? currentMe() : undefined;
