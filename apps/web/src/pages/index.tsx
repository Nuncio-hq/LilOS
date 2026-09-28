import { FirstRun } from "@lilos/ui";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAtom } from "../lib/hooks";
import { toUiEmployee } from "../lib/mapping";
import {
  currentCompany,
  currentName,
  DEFAULT_AVATAR_COLOR,
  osFullName,
  profile,
} from "../lib/me";
import { relay } from "../lib/runtime";

const ONBOARDED_KEY = "lilos-onboarded";

/**
 * `/` — first run. AC-1: when the company is brand new the harness has
 * already auto-hired the engine's `default` profile, so we show that employee
 * in the FirstRun card; a returning user (or any employee list) goes straight
 * to the first DM. The name/company fields fold into the card (prefilled from
 * the OS user); "Open DM" persists them as relay settings (#118 AC-2).
 */
export function IndexPage() {
  const employees = useAtom(relay.employees);
  // Prefill resolves live: stored settings > the OS full name (#118 AC-4).
  useAtom(profile);
  useAtom(osFullName);
  const navigate = useNavigate();
  const first = employees[0];

  useEffect(() => {
    if (first && localStorage.getItem(ONBOARDED_KEY)) {
      void navigate({
        to: "/dm/$employeeId",
        params: { employeeId: first.id },
        replace: true,
      });
    }
  }, [first, navigate]);

  if (!first) {
    return (
      <div className="grid min-w-0 flex-1 place-items-center text-muted-foreground text-sm">
        Hiring your first employee…
      </div>
    );
  }
  const e = toUiEmployee(first);
  const dismiss = () => localStorage.setItem(ONBOARDED_KEY, "1");
  const goDm = () =>
    void navigate({
      to: "/dm/$employeeId",
      params: { employeeId: first.id },
    });
  return (
    <div className="min-w-0 flex-1">
      <FirstRun
        employee={e}
        identity={{ name: currentName(), company: currentCompany() }}
        onOpenDM={(id) => {
          dismiss();
          // Persist what was typed — an emptied company keeps the derived
          // "<first>'s Co" rather than storing a blank.
          void relay
            .updateSettings({
              userName: id.name,
              companyName: id.company || undefined,
              avatarColor: DEFAULT_AVATAR_COLOR,
            })
            .catch(() => {});
          goDm();
        }}
        onSkip={() => {
          dismiss();
          goDm();
        }}
      />
    </div>
  );
}
