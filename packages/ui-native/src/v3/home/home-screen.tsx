import { Hairline, Page, SectionBlock, SerifTitle, T } from "../kit";
import type { AskVM } from "../types";
import { AskRow, CountStrip, TeamRow, UpdateBlock } from "./home-parts";
import type {
  HomeCountKey,
  HomeCounts,
  HomeTeamRow,
  HomeUpdate,
} from "./types";

/* Home: the company's name, the CEO's latest word, three counts, the asks
   that have waited longest, then the whole team. Each fact appears once —
   results to look at live on the Needs tab. */
export function HomeScreen({
  title,
  date,
  update,
  counts,
  asks,
  asksTotal,
  team,
  onOpenUpdate,
  onOpenCount,
  onOpenAsk,
  onApprove,
  onDeny,
  onSeeAllAsks,
  onOpenAgent,
}: {
  /** The company's name. */
  title: string;
  /** Today's date line under the title. */
  date?: string;
  /** Absent: the company has no CEO or no tickets, so nothing to read. */
  update?: HomeUpdate;
  counts: HomeCounts;
  /** The longest-waiting asks that fit on Home (at most two). */
  asks: AskVM[];
  /** All open asks; above `asks.length` the header offers "See all". */
  asksTotal: number;
  /** Everyone on the team, the CEO first. */
  team: HomeTeamRow[];
  onOpenUpdate: () => void;
  onOpenCount: (key: HomeCountKey) => void;
  /** Tap on an ask's text: show it in the Needs tab. */
  onOpenAsk: (id: string) => void;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onSeeAllAsks: () => void;
  onOpenAgent: (id: string) => void;
}) {
  return (
    <Page testID="home-screen">
      <SerifTitle>{title}</SerifTitle>
      {date ? (
        <T variant="small" tone="ink3" className="-mt-2 px-5 pb-3">
          {date}
        </T>
      ) : null}
      {update ? (
        <UpdateBlock update={update} onPress={onOpenUpdate} />
      ) : (
        <Hairline />
      )}
      <CountStrip counts={counts} onOpen={onOpenCount} />
      {asks.length > 0 ? (
        <SectionBlock
          title="Needs you"
          action={asksTotal > asks.length ? `See all ${asksTotal}` : undefined}
          onAction={onSeeAllAsks}
        >
          {asks.map((ask, i) => (
            <AskRow
              key={ask.id}
              ask={ask}
              last={i === asks.length - 1}
              onOpen={onOpenAsk}
              onApprove={onApprove}
              onDeny={onDeny}
            />
          ))}
        </SectionBlock>
      ) : null}
      <SectionBlock title="Team">
        {team.map((row, i) => (
          <TeamRow
            key={row.person.id}
            row={row}
            last={i === team.length - 1}
            onPress={onOpenAgent}
          />
        ))}
      </SectionBlock>
    </Page>
  );
}
