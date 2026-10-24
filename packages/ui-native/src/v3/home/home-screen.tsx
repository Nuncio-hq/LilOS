import { Modules, Page, type RingPerson, StatTile, StatTiles } from "../kit";
import { ResultsModule } from "../needs/results";
import type { AskVM, ResultVM } from "../types";
import { HeroAsk } from "./hero-ask";
import { TeamModule, UpdateModule } from "./modules";
import type { HomeCountKey, HomeCounts, HomeUpdate } from "./types";

/* Home answers one question — what needs me now? — in a short stack of
   modules: three numbers, the one ask that matters most, the latest word
   from the CEO, who is on the team, and what finished. The company's name is
   the native large title. */

/** Results shown on Home; the rest are in the Needs you tab. */
const RESULT_ROWS = 2;

export function HomeScreen({
  counts,
  hero,
  moreAsks,
  update,
  team,
  results,
  onOpenCount,
  onApprove,
  onDeny,
  onAnswer,
  onReviewPlan,
  onOpenNeeds,
  onOpenUpdate,
  onOpenTeam,
  onOpenAgent,
  onOpenResult,
}: {
  counts: HomeCounts;
  /** The most urgent ask. Absent: nothing waits on you. */
  hero?: AskVM;
  /** The other open asks. */
  moreAsks: number;
  /** Absent: the company has no CEO or no tickets, so nothing to read. */
  update?: HomeUpdate;
  team: RingPerson[];
  results: ResultVM[];
  onOpenCount: (key: HomeCountKey) => void;
  onApprove: (askId: string) => void;
  onDeny: (askId: string) => void;
  onAnswer: (askId: string, option: string) => void;
  onReviewPlan: (threadId: string) => void;
  onOpenNeeds: () => void;
  onOpenUpdate: () => void;
  onOpenTeam: () => void;
  onOpenAgent: (id: string) => void;
  onOpenResult: (key: string) => void;
}) {
  return (
    <Page testID="home-screen">
      <Modules>
        <StatTiles>
          <StatTile
            testID="home-count-working"
            value={counts.working}
            label="Working"
            tone="work"
            onPress={() => onOpenCount("working")}
          />
          <StatTile
            testID="home-count-needs"
            value={counts.needs}
            label="Needs you"
            tone="needs"
            onPress={() => onOpenCount("needs")}
          />
          <StatTile
            testID="home-count-stuck"
            value={counts.stuck}
            label="Stuck"
            tone="stuck"
            onPress={() => onOpenCount("stuck")}
          />
        </StatTiles>
        {hero ? (
          <HeroAsk
            ask={hero}
            more={moreAsks}
            onApprove={onApprove}
            onDeny={onDeny}
            onAnswer={onAnswer}
            onReview={onReviewPlan}
            onMore={onOpenNeeds}
          />
        ) : null}
        {update ? <UpdateModule update={update} onOpen={onOpenUpdate} /> : null}
        <TeamModule
          people={team}
          onOpen={onOpenTeam}
          onOpenAgent={onOpenAgent}
        />
        <ResultsModule
          rows={results}
          max={RESULT_ROWS}
          onOpen={onOpenResult}
          onMore={onOpenNeeds}
        />
      </Modules>
    </Page>
  );
}
