import { beforeEach, describe, expect, it } from "vitest";
import {
  currentCompany,
  currentMe,
  humanFor,
  osFullName,
  profile,
  USER_ID,
} from "../src/lib/me";

/**
 * Issue #118 — the signed-in human's identity (name, company, avatar colour)
 * resolves stored-over-OS-over-fallback: relay settings win (AC-1), the OS
 * full name prefills when the relay has nothing yet (AC-4).
 */

beforeEach(() => {
  profile.set({});
  osFullName.set(null);
});

describe("AC-4 prefill when the relay stores nothing", () => {
  it("uses the OS user's full name for the human and '<first>'s Co' for the company", () => {
    osFullName.set("Test User");
    expect(currentMe().name).toBe("Test User");
    expect(currentCompany()).toBe("Test's Co");
  });

  it("falls back to neutral placeholders when nothing is known", () => {
    expect(currentMe().name).toBe("Me");
    expect(currentCompany()).toBe("My Co");
  });
});

describe("AC-1 stored settings win over prefill", () => {
  it("stored name/company/colour replace the OS-derived values", () => {
    osFullName.set("Test User");
    profile.set({
      userName: "Ada",
      companyName: "Ada Labs",
      avatarColor: "bg-rose-600",
    });
    expect(currentMe()).toEqual({ name: "Ada", color: "bg-rose-600" });
    expect(currentCompany()).toBe("Ada Labs");
  });

  it("a stored name alone still derives the company from it", () => {
    profile.set({ userName: "Ada" });
    expect(currentCompany()).toBe("Ada's Co");
  });

  it("the avatar colour defaults when only the name is stored", () => {
    profile.set({ userName: "Ada" });
    expect(currentMe().color).toBe("bg-blue-600");
  });
});

describe("AC-1 humanFor resolves the signed-in human", () => {
  it("maps the user author id to the effective human", () => {
    osFullName.set("Test User");
    expect(humanFor(USER_ID)?.name).toBe("Test User");
    expect(humanFor("nobody")).toBeUndefined();
  });
});
