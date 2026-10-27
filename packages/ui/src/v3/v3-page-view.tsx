import { V3Goals } from "./v3-goals";
import { V3Guide } from "./v3-guide";
import { V3Hire } from "./v3-hire";
import { V3Home } from "./v3-home";
import { V3Inbox } from "./v3-inbox";
import { V3Needs } from "./v3-needs";
import type { V3PageProps, V3PageRoute } from "./v3-page-types";
import { V3People } from "./v3-people";
import { V3Settings } from "./v3-settings";
import { V3Threads } from "./v3-threads";
import { V3Work } from "./v3-work";

/** The page's name, for the head of the side peek's trail. */
export const PAGE_NAME: Record<V3PageRoute["page"], string> = {
  home: "Home",
  needs: "Needs you",
  inbox: "Inbox",
  work: "Work",
  threads: "Threads",
  goals: "Goals",
  people: "People",
  hire: "Add an agent",
  guide: "How it works",
  settings: "Settings",
  welcome: "Welcome",
};

/** The page the sidebar is on, drawn in the shell's page column. */
export function V3PageView({
  page,
  ...props
}: V3PageProps & { page: V3PageRoute }) {
  return (
    <>
      {page.page === "home" && <V3Home {...props} />}
      {page.page === "needs" && <V3Needs {...props} />}
      {page.page === "inbox" && <V3Inbox {...props} />}
      {page.page === "work" && (
        <V3Work {...props} view={page.view ?? "waiting"} />
      )}
      {page.page === "threads" && <V3Threads {...props} view={page.view} />}
      {page.page === "goals" && <V3Goals {...props} />}
      {page.page === "people" && (
        <V3People {...props} view={page.view ?? "table"} />
      )}
      {page.page === "hire" && <V3Hire {...props} />}
      {page.page === "guide" && <V3Guide {...props} />}
      {page.page === "settings" && (
        <V3Settings {...props} view={page.view ?? "general"} />
      )}
    </>
  );
}
