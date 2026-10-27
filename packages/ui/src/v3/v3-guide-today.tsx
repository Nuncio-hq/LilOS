import { Page, Title } from "./v3-bits";
import { companyOn } from "./v3-model";
import type { V3PageProps } from "./v3-page-types";

/* How it works (#885): three lines, nothing more — the app shows the rest
   by doing it. */

export function V3GuideToday({ data }: Pick<V3PageProps, "data" | "go">) {
  const company = companyOn(data);
  return (
    <Page wide>
      <Title>{company ? "How the company works" : "How it works"}</Title>
      <div className="mt-4 max-w-md space-y-3 text-[15px] text-muted-foreground">
        <p>
          Agents do the work. Each one works in a thread — its own chat, folder
          and memory.
        </p>
        <p>
          When a thread needs you — an approval or a question — it waits under
          Needs you.
        </p>
        <p>
          Threads lists everything in flight; open one to watch, reply, or stop
          it.
        </p>
      </div>
    </Page>
  );
}
