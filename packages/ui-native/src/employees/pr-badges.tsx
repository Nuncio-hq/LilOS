import { Text, View } from "react-native";
import { AppText } from "../components/app-text";
import { Icon, type IconTone } from "../components/icon";
import type { PullRequestRef } from "./types";

/* Pull requests a session opened, GitHub's language on iOS symbols:
   green = open, purple = merged, gray = draft, red = closed. A session can
   open several, so every surface shows them as a set: rows show up to three
   numbers then "+N", the header says "3 PRs", the info sheet lists them all. */

const LOOK: Record<
  PullRequestRef["status"],
  {
    icon: Parameters<typeof Icon>[0]["name"];
    tone: IconTone;
    text: string;
    label: string;
  }
> = {
  open: {
    icon: "arrow.triangle.pull",
    tone: "success",
    text: "text-success",
    label: "Open",
  },
  draft: {
    icon: "arrow.triangle.pull",
    tone: "muted-foreground",
    text: "text-muted-foreground",
    label: "Draft",
  },
  merged: {
    icon: "arrow.triangle.merge",
    tone: "merged",
    text: "text-merged",
    label: "Merged",
  },
  closed: {
    icon: "xmark.circle",
    tone: "destructive",
    text: "text-destructive",
    label: "Closed",
  },
};

/** Open work first (what you may still act on), then merged, then the rest. */
const ORDER = { open: 0, draft: 1, merged: 2, closed: 3 } as const;
export function sortPrs(prs: PullRequestRef[]) {
  return [...prs].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || b.number - a.number,
  );
}

/** "Open · checks running", "Merged", "Draft · checks failing". */
export function prStatusLabel(pr: PullRequestRef) {
  const base = LOOK[pr.status].label;
  if (pr.status !== "open" && pr.status !== "draft") return base;
  if (pr.checks === "pending") return `${base} · checks running`;
  if (pr.checks === "failing") return `${base} · checks failing`;
  if (pr.checks === "passing") return `${base} · checks passed`;
  return base;
}

export function PrIcon({
  pr,
  size = 12,
}: {
  pr: PullRequestRef;
  size?: number;
}) {
  const l = LOOK[pr.status];
  return <Icon name={l.icon} size={size} tone={l.tone} weight="semibold" />;
}

/** One PR as "⇅ #94" in its status color. */
export function PrBadge({ pr }: { pr: PullRequestRef }) {
  return (
    <View className="flex-row items-center gap-0.5">
      <PrIcon pr={pr} />
      <Text
        className={`font-medium text-[13px] ${LOOK[pr.status].text}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {`#${pr.number}`}
      </Text>
    </View>
  );
}

/** A row's PRs: up to three badges, then "+N". */
export function PrBadges({
  prs,
  max = 3,
}: {
  prs: PullRequestRef[];
  max?: number;
}) {
  const sorted = sortPrs(prs);
  const rest = sorted.length - max;
  return (
    <View
      accessible
      accessibilityLabel={sorted
        .map((p) => `PR ${p.number}, ${prStatusLabel(p)}`)
        .join("; ")}
      className="flex-row items-center gap-2"
    >
      {sorted.slice(0, max).map((p) => (
        <PrBadge key={p.number} pr={p} />
      ))}
      {rest > 0 && (
        <AppText tone="muted" className="text-[13px]">
          {`+${rest}`}
        </AppText>
      )}
    </View>
  );
}

/** Header summary: one PR by number and state; several as a count. */
export function prHeadline(prs: PullRequestRef[]) {
  if (prs.length === 1) {
    const p = prs[0];
    return `#${p.number} ${LOOK[p.status].label.toLowerCase()}`;
  }
  const merged = prs.filter((p) => p.status === "merged").length;
  return merged === prs.length
    ? `${prs.length} PRs merged`
    : merged
      ? `${prs.length} PRs · ${merged} merged`
      : `${prs.length} PRs`;
}

/** The card under the turn that opened a PR (web: PrCard) — the reply
   "status is live on the card below" points at this. */
export function PrCard({ pr }: { pr: PullRequestRef }) {
  const l = LOOK[pr.status];
  return (
    <View
      accessible
      accessibilityLabel={`PR ${pr.number}, ${pr.title}, ${prStatusLabel(pr)}`}
      className="flex-row items-center gap-3 self-start rounded-[18px] bg-card px-3.5 py-3"
      style={{ borderCurve: "continuous" }}
    >
      <View className="grid size-8 shrink-0 place-items-center rounded-xl bg-fill">
        <Icon name={l.icon} size={15} tone={l.tone} weight="semibold" />
      </View>
      <View className="min-w-0">
        <AppText weight="medium" numberOfLines={1} className="text-[15px]">
          {pr.title}
        </AppText>
        <View className="mt-0.5 flex-row items-center gap-1.5">
          <Text
            className={`font-medium text-[13px] ${l.text}`}
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {`#${pr.number}`}
          </Text>
          <AppText tone="muted" className="text-[13px]">
            ·
          </AppText>
          <AppText tone="muted" className="text-[13px]">
            {prStatusLabel(pr)}
          </AppText>
        </View>
      </View>
    </View>
  );
}

/** A DM row's PR line. One PR says its state in words ("#96 Draft ·
    checks failing"); several show as badges, open first, then "+N". */
export function PrLine({ prs }: { prs: PullRequestRef[] }) {
  if (prs.length === 1) {
    const pr = prs[0];
    return (
      <View className="mt-0.5 flex-row items-center gap-1.5">
        <PrBadge pr={pr} />
        <AppText tone="muted" numberOfLines={1} className="shrink text-[13px]">
          {prStatusLabel(pr)}
        </AppText>
      </View>
    );
  }
  return (
    <View className="mt-0.5 flex-row items-center gap-2">
      <PrBadges prs={prs} />
      <AppText tone="muted" numberOfLines={1} className="shrink text-[13px]">
        {prHeadline(prs)}
      </AppText>
    </View>
  );
}
