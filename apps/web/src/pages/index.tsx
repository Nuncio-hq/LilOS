import { FirstRun } from "@lilos/ui";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAtom } from "../lib/hooks";
import { toUiEmployee } from "../lib/mapping";
import { relay } from "../lib/runtime";

const ONBOARDED_KEY = "lilos-onboarded";

/**
 * `/` — first run. AC-1: when the company is brand new the harness has
 * already auto-hired the engine's `default` profile, so we show that employee
 * in the FirstRun card; a returning user (or any employee list) goes straight
 * to the first DM.
 */
export function IndexPage() {
  const employees = useAtom(relay.employees);
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
  return (
    <div className="min-w-0 flex-1">
      <FirstRun
        employee={e}
        onOpenDM={() => {
          dismiss();
          void navigate({
            to: "/dm/$employeeId",
            params: { employeeId: first.id },
          });
        }}
        onSkip={() => {
          dismiss();
          void navigate({
            to: "/dm/$employeeId",
            params: { employeeId: first.id },
          });
        }}
      />
    </div>
  );
}
