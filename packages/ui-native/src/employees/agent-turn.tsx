import { useState } from "react";
import { LayoutAnimation, Pressable, Text, View } from "react-native";
import { AppText } from "../components/app-text";
import { Card, CommandLine, nonBreaking, Pill } from "../components/bits";
import { Icon } from "../components/icon";
import { Orb, type OrbTone } from "../components/orb";
import { Prose, Pulse } from "../components/prose";
import {
  cardLine,
  decidedVerb,
  describeAsk,
  GRANT_LABEL,
  grantPills,
} from "./approval-copy";

import { type PlanAction, PlanCard } from "./plan-card";
import { PrCard } from "./pr-badges";
import { type QuestionAnswer, QuestionCard } from "./question-card";
import { isAnswerableQuestion } from "./question-gate";
import { StepRow, tool } from "./step-row";
import { SubagentsCard, SubagentsLink } from "./subagents";
import type {
  AgentEntry,
  Approval,
  GrantOption,
  SubagentRow,
  ToolStep,
} from "./types";

/* One conversation turn — the mobile twin of the web AgentTurn/UserTurn
   (packages/ui/src/conversation/turns.tsx): who + time, "Thought for Ns"
   (collapsible reasoning), the turn's tool calls collapsed into one
   "N steps" block (open while live), the reply, the approval card, and a
   quiet footer. Yours are tinted bubbles on the right; the employee's sit
   on the page under its orb, so the two never read alike. */

const ease = () =>
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);

export function UserBubble({ text, time }: { text: string; time?: string }) {
  return (
    <View className="items-end gap-1 pl-14">
      <View
        className="rounded-[20px] rounded-br-[6px] bg-primary px-3.5 py-2"
        style={{ borderCurve: "continuous" }}
      >
        <AppText tone="inverse" className="text-[17px] leading-[22px]">
          {text}
        </AppText>
      </View>
      {time && (
        <AppText size="xs" tone="muted" className="pr-1">
          {time.startsWith("Queued") || time.startsWith("Waiting")
            ? time
            : `You · ${time}`}
        </AppText>
      )}
    </View>
  );
}

export function AgentTurn({
  e,
  name,
  tone,
  onApprove,
  onDeny,
  onGrant,
  onAnswer,
  onOpenSubagent,
  onOpenSubagents,
  onPlan,
  onOpenPlan,
  stale,
  answerHint,
}: {
  e: AgentEntry;
  name: string;
  tone: OrbTone;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  /** #601: the tapped option on an approval card — one of the ask's own
      grantOptions (Once / This session / Always / Deny). */
  onGrant?: (id: string, option: GrantOption) => void;
  /** #420: a question ask's answer (options send their wire id, free text
      the typed string); a question's Cancel rides `onDeny`. */
  onAnswer?: (id: string, answer: QuestionAnswer) => void;
  /** Opens a subagent's sheet (issue #170); absent = rows don't open. */
  onOpenSubagent?: (a: SubagentRow) => void;
  /** #319: the session's Subagents sheet exists — the turn shows only the
     one-line link and the rows live there (web: Workbench → Subagents).
     Absent = the inline card stays. */
  onOpenSubagents?: () => void;
  /** Approve / Change / Reject on this turn's plan (issue #175). */
  onPlan?: (a: PlanAction, planId: string) => void;
  onOpenPlan?: () => void;
  /** #652: the Mac is unreachable — open asks render visibly disabled
      (nothing can be sent or queued) and the card says they wake when
      the Mac is back. */
  stale?: boolean;
  answerHint?: string;
}) {
  const steps = e.steps ?? [];
  /* #264: an open ask blocks the turn — nothing is still thinking or
     running, so the reasoning row swaps "Thinking…" for "Waiting for
     you" instead of shimmering on. #327: thinking itself comes from the
     entry (`live && phase === "reasoning"`, set by thread-model) — a
     turn that finished or moved past reasoning collapses to "Thought
     for Ns" with a working chevron instead of staying expanded. */
  const waiting = e.waiting !== undefined;
  const thinking = !!e.thinking && !waiting;
  const writing = !!e.live && !waiting && !!e.writing && !e.text?.trim();
  return (
    <View className="gap-2.5">
      <View className="flex-row items-center gap-2">
        <Orb tone={tone} size={20} />
        <AppText weight="semibold" className="text-[15px]">
          {name}
        </AppText>
        <AppText size="xs" tone="muted">
          {e.time}
        </AppText>
      </View>
      {e.reasoning !== undefined && (
        <Reasoning
          text={e.reasoning}
          seconds={e.thought}
          thinking={!!thinking}
          /* A turn that already measured its reasoning keeps the
             tappable "Thought for Ns" even while an ask blocks it —
             "Waiting for you" only stands in for unmeasured thinking. */
          waiting={waiting && e.thought === undefined}
        />
      )}
      {steps.length > 0 && (
        <Steps
          steps={steps}
          live={!!e.live && !e.writing}
          waiting={e.waiting}
        />
      )}
      {!!e.subagents?.length &&
        (onOpenSubagents ? (
          <SubagentsLink agents={e.subagents} onOpen={onOpenSubagents} />
        ) : (
          <SubagentsCard agents={e.subagents} onOpen={onOpenSubagent} />
        ))}
      {e.text ? (
        <Prose text={e.text} />
      ) : (
        writing && (
          <Pulse>
            <AppText size="sm" tone="muted" weight="medium">
              Writing…
            </AppText>
          </Pulse>
        )
      )}
      {e.pr && <PrCard pr={e.pr} />}
      {e.plan && (
        <PlanCard
          plan={e.plan}
          onAction={onPlan}
          onOpen={onOpenPlan}
          stale={stale}
          answerHint={answerHint}
        />
      )}
      {e.decided && <Receipt d={e.decided} />}
      {e.stopped && (
        <View className="flex-row items-center gap-1.5">
          <View className="size-2.5 rounded-[2px] bg-muted-foreground" />
          <AppText size="xs" tone="muted" weight="medium">
            You stopped this turn
          </AppText>
        </View>
      )}
      {/* #419: the turn died on an engine error — the failure line carries
          its text like web's "Failed · <error>" chip. */}
      {e.failed !== undefined && (
        <View className="flex-row items-center gap-1.5">
          <View className="size-2.5 rounded-[2px] bg-destructive" />
          <AppText size="xs" tone="destructive" weight="medium">
            Turn failed{e.failed ? ` · ${e.failed}` : ""}
          </AppText>
        </View>
      )}
      {e.agentInitiated && (
        <View className="flex-row items-center gap-1.5">
          <View className="size-2.5 rounded-[2px] bg-muted-foreground" />
          <AppText size="xs" tone="muted" weight="medium">
            Agent-initiated
          </AppText>
        </View>
      )}
      {e.approval &&
        (isAnswerableQuestion(e.approval) ? (
          <QuestionCard
            a={e.approval}
            onAnswer={onAnswer}
            onCancel={onDeny}
            stale={stale}
            answerHint={answerHint}
          />
        ) : (
          <ApprovalCard
            a={e.approval}
            onApprove={onApprove}
            onDeny={onDeny}
            onGrant={onGrant}
            stale={stale}
            answerHint={answerHint}
          />
        ))}
      {e.footer && !e.live && !e.stopped && <Footer f={e.footer} />}
    </View>
  );
}

function Reasoning({
  text,
  seconds,
  thinking,
  waiting,
}: {
  text: string;
  seconds?: number;
  thinking: boolean;
  /** The turn is blocked on an open ask mid-reasoning (#264). */
  waiting?: boolean;
}) {
  /* #320: like the web Reasoning — streaming opens the block by default,
     the first user tap wins for the rest of the turn. */
  const [userSet, setUserSet] = useState<boolean>();
  const shown = userSet ?? thinking;
  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          thinking
            ? "Thinking"
            : waiting
              ? "Waiting for you"
              : seconds
                ? `Thought for ${seconds}s`
                : "Thought"
        }
        disabled={waiting}
        onPress={() => {
          ease();
          setUserSet(!shown);
        }}
        hitSlop={6}
        className="flex-row items-center gap-1.5 self-start active:opacity-60"
      >
        {thinking ? (
          <Pulse>
            <AppText size="sm" tone="muted" weight="medium">
              Thinking…
            </AppText>
          </Pulse>
        ) : waiting ? (
          <AppText size="sm" tone="muted" weight="medium">
            Waiting for you
          </AppText>
        ) : (
          <AppText size="sm" tone="muted" weight="medium">
            {seconds ? `Thought for ${seconds}s` : "Thought"}
          </AppText>
        )}
        {!waiting && (
          <Icon
            name={shown ? "chevron.down" : "chevron.right"}
            size={10}
            weight="bold"
            tone="muted-foreground"
          />
        )}
      </Pressable>
      {shown && !!text && (
        <View className="border-muted-strong border-l-2 pl-3">
          <AppText
            size="sm"
            tone="muted"
            className="text-[14px] italic leading-[20px]"
          >
            {text}
          </AppText>
        </View>
      )}
    </View>
  );
}

/* All of a turn's tool calls behind one "N steps" row (web: Task block).
   Live turns keep it open so you watch the work land. */
function Steps({
  steps,
  live,
  waiting,
}: {
  steps: ToolStep[];
  live: boolean;
  /** Kind of ask the live turn is blocked on (#264). */
  waiting?: "approval" | "plan" | "question";
}) {
  /* #320: a live turn opens the block by default — the first user tap wins
     for the rest of the turn, so collapsing mid-run stays collapsed. */
  const [userSet, setUserSet] = useState<boolean>();
  const shown = userSet ?? live;
  const running = steps.find((s) => s.running);
  const files = new Set(
    steps.filter((s) => s.add !== undefined).map((s) => s.arg),
  ).size;
  return (
    <View
      className="overflow-hidden rounded-[18px] bg-card"
      style={{ borderCurve: "continuous" }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${steps.length} steps`}
        onPress={() => {
          ease();
          setUserSet(!shown);
        }}
        className="h-11 flex-row items-center gap-2 px-3.5 active:bg-fill"
      >
        {waiting ? (
          <View className="size-2 rounded-full bg-primary" />
        ) : live ? (
          <Pulse>
            <View className="size-2 rounded-full bg-work" />
          </Pulse>
        ) : (
          <Icon name="checkmark" size={11} weight="bold" tone="success" />
        )}
        <AppText size="sm" weight="medium" className="flex-1">
          {waiting
            ? "Waiting for you"
            : running
              ? `Step ${steps.indexOf(running) + 1} · ${tool(running.tool).now}…`
              : live
                ? `${steps.length} ${steps.length === 1 ? "step" : "steps"} · Working…`
                : `${steps.length} ${steps.length === 1 ? "step" : "steps"}`}
          {!live && files > 0 && (
            <AppText size="sm" tone="muted">
              {` · ${files} ${files === 1 ? "file" : "files"}`}
            </AppText>
          )}
        </AppText>
        {!shown && <ToolIcons steps={steps} />}
        <Icon
          name={shown ? "chevron.up" : "chevron.down"}
          size={11}
          weight="semibold"
          tone="muted-foreground"
        />
      </Pressable>
      {shown && (
        <View>
          {steps.map((s) => (
            <StepRow key={s.id} s={s} waiting={waiting} />
          ))}
        </View>
      )}
    </View>
  );
}

function ToolIcons({ steps }: { steps: ToolStep[] }) {
  const kinds = [...new Set(steps.map((s) => s.tool))].slice(0, 4);
  return (
    <View className="flex-row gap-1.5">
      {kinds.map((k) => (
        <Icon key={k} name={tool(k).icon} size={12} tone="muted-foreground" />
      ))}
    </View>
  );
}

function ApprovalCard({
  a,
  onApprove,
  onDeny,
  onGrant,
  flat,
  stale,
  answerHint,
}: {
  a: Approval;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  /** #601: one pill per option the ask offered, in its order. */
  onGrant?: (id: string, option: GrantOption) => void;
  /** Inside a session card: no second border, no label (the chip says it). */
  flat?: boolean;
  /** #652: the Mac is unreachable — the pills render disabled and the
      hint says when answering works again. */
  stale?: boolean;
  answerHint?: string;
}) {
  const Box = flat ? FlatBox : Card;
  /* #652 AC-2: the ask's human description once — file tools get a
     path detail line, shell commands keep the `$` box, unknown tools'
     args hide behind the Args tap. */
  const d = describeAsk(a.command);
  const isFileAsk = !!d?.detail && !d.detail.startsWith("{");
  const [showArgs, setShowArgs] = useState(false);
  return (
    // Its own responder, so a tap on the card never opens the row under it.
    <View onStartShouldSetResponder={() => true}>
      <Box>
        {!flat && (
          <View className="mb-1.5 flex-row items-center gap-1.5">
            <View className="size-1.5 rounded-full bg-primary" />
            <AppText
              size="xs"
              weight="semibold"
              tone="none"
              className="text-accent-text"
            >
              Needs your OK
            </AppText>
          </View>
        )}
        {/* #264/#652: one human sentence — a file tool reads
            "wants to edit <file>" with its full path under it, a real
            shell command keeps the `$` box, an unknown tool's args sit
            behind an Args tap. Never the raw `{…}` line. */}
        <AppText size="sm" className="leading-5">
          {cardLine(a)}
        </AppText>
        {d?.detail && isFileAsk && (
          <AppText size="xs" tone="muted" className="mt-1 font-mono">
            {d.detail}
          </AppText>
        )}
        {d?.detail && !isFileAsk && (
          <Pressable onPress={() => setShowArgs((v) => !v)} className="mt-1">
            <AppText size="xs" tone="muted">
              {showArgs ? "Hide args" : "Args…"}
            </AppText>
          </Pressable>
        )}
        {d?.detail && !isFileAsk && showArgs && (
          <View className="mt-2">
            <CommandLine command={d.detail} />
          </View>
        )}
        {d?.boxed && (
          <View className="mt-2.5">
            <CommandLine command={d.boxed} />
          </View>
        )}
        {a.file && (
          <View className="mt-2.5 flex-row items-center gap-2.5 rounded-xl bg-background px-3 py-2.5">
            <Icon name="doc.text" size={15} tone="subtle-foreground" />
            <View className="flex-1">
              <Text className="font-mono text-[13px] text-foreground">
                {a.file.name}
              </Text>
              <AppText size="xs" tone="muted">
                {a.file.detail}
              </AppText>
            </View>
          </View>
        )}
        <View className="mt-3 flex-row flex-wrap items-center gap-2">
          {/* #601: the ask's own options, its own order — the first grant
              is the prominent pill like the Mac's first action, Deny reads
              soft. A pre-options row (prototype) falls back to Approve +
              Deny via grantPills. */}
          {a.kind === "approval" && onGrant ? (
            grantPills(a).map((opt, i) => (
              <Pill
                key={opt}
                label={GRANT_LABEL[opt]}
                variant={i === 0 && opt !== "deny" ? undefined : "soft"}
                disabled={stale}
                onPress={() => onGrant(a.id, opt)}
              />
            ))
          ) : (
            <>
              {a.kind !== "question" && (
                <Pill
                  label="Approve"
                  disabled={stale}
                  onPress={() => onApprove(a.id)}
                />
              )}
              <Pill
                label="Deny"
                variant="soft"
                disabled={stale}
                onPress={() => onDeny(a.id)}
              />
            </>
          )}
        </View>
        {stale && answerHint && (
          <AppText size="xs" tone="muted" className="mt-1.5">
            {answerHint}
          </AppText>
        )}
      </Box>
    </View>
  );
}

function FlatBox({ children }: { children: React.ReactNode }) {
  return <View className="px-3.5 pt-3 pb-3.5">{children}</View>;
}

/** 412 → "6m 52s", 34 → "34s". */
function duration(s: number) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

/* Steps and files already sit on the steps row, so the footer only says
   how long and on what. */
function Footer({ f }: { f: NonNullable<AgentEntry["footer"]> }) {
  const bits = [
    f.dur !== undefined && `Worked for ${duration(f.dur)}`,
    f.model,
    f.effort,
  ].filter(Boolean);
  return (
    <AppText size="xs" tone="muted">
      {bits.join(" · ")}
    </AppText>
  );
}

/* After you choose, the ask folds to a receipt so the thread keeps a
   record of what you allowed — "You approved:" + the command in mono,
   wrapped whole rather than truncated (#264). */
function Receipt({ d }: { d: NonNullable<AgentEntry["decided"]> }) {
  return (
    <View className="flex-row items-center gap-2 self-start rounded-2xl bg-fill py-1.5 pr-3 pl-2.5">
      <Icon
        name={d.approved ? "checkmark.circle.fill" : "xmark.circle.fill"}
        size={13}
        tone={d.approved ? "primary" : "muted-foreground"}
      />
      <Text className="shrink text-[13px] text-subtle-foreground">
        <Text className="font-medium text-foreground">
          {d.question
            ? d.approved
              ? "You answered: "
              : "You cancelled: "
            : `${decidedVerb(d.outcome, d.approved)} `}
        </Text>
        <Text className="font-mono text-[12px]">{nonBreaking(d.what)}</Text>
      </Text>
    </View>
  );
}
