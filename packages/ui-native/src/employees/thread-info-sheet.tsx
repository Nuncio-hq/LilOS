import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../components/app-text";
import { StateChip } from "../components/bits";
import { Icon } from "../components/icon";
import { Orb } from "../components/orb";
import { ContextMeter } from "./context-meter";
import { Group, SheetHeader } from "./folder-picker";
import { PrIcon, PrStatusText, prHeadline, sortPrs } from "./pr-badges";
import type { ThreadDetail } from "./types";

/* A session's facts (web: the thread header's ws badge + session code +
   usage), as an iOS info sheet: who and what up top, then grouped rows. */
export function ThreadInfoSheet({
  t,
  onDone,
}: {
  t: ThreadDetail;
  onDone: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingBottom: Math.max(insets.bottom, 16) + 12,
        gap: 22,
      }}
    >
      <View className="-mx-4">
        <SheetHeader title="Session" onDone={onDone} />
      </View>
      <View className="items-center gap-2">
        <Orb tone={t.employee.tone} size={56} />
        <AppText
          weight="semibold"
          className="px-6 text-center text-[20px] leading-6"
        >
          {t.title}
        </AppText>
        <View className="flex-row items-center gap-2">
          <AppText tone="muted" className="text-[14px]">
            {t.employee.name}
          </AppText>
          <StateChip state={t.state} />
        </View>
      </View>

      <Group title="Where it runs">
        <Fact
          icon="folder"
          label="Folder"
          value={t.folder ? t.folder.path : "None · just chat"}
          mono={!!t.folder}
          first
        />
        {t.branch && (
          <Fact
            icon="arrow.triangle.branch"
            label="Branch"
            value={t.branch.name}
            detail={t.branch.detail}
            mono
          />
        )}
      </Group>

      {!!t.prs?.length && (
        <Group
          title="Pull requests"
          note={t.prs.length > 1 ? prHeadline(t.prs) : undefined}
        >
          {sortPrs(t.prs).map((pr, i) => (
            <View key={pr.number} className="flex-row items-center gap-3 pl-4">
              <View className="w-5 items-center">
                <PrIcon pr={pr} size={15} />
              </View>
              <View
                className={`min-h-[56px] flex-1 justify-center gap-0.5 py-2.5 pr-4 ${i ? "border-border border-t" : ""}`}
              >
                <AppText numberOfLines={1} className="text-[16px]">
                  <AppText tone="muted" className="text-[16px]">
                    {`#${pr.number} `}
                  </AppText>
                  {pr.title}
                </AppText>
                <PrStatusText pr={pr} />
              </View>
            </View>
          ))}
        </Group>
      )}

      {!!t.jobs?.length && (
        <Group title="Background">
          {t.jobs.map((j, i) => (
            <Fact
              key={j.id}
              icon={j.status === "running" ? "play.circle" : "stop.circle"}
              label={
                j.status === "running"
                  ? "Running"
                  : j.status === "failed"
                    ? "Failed"
                    : "Ended"
              }
              value={j.command}
              detail={
                j.status === "running" ? `up ${j.uptime}` : `ran ${j.uptime}`
              }
              mono
              first={i === 0}
            />
          ))}
        </Group>
      )}

      {t.context && <ContextMeter c={t.context} model={t.model} />}

      <Group title="Session">
        <Fact icon="calendar" label="Started" value={t.started} first />
        {!t.context && <Fact icon="sparkle" label="Model" value={t.model} />}
        {t.usage && !t.context && (
          <Fact
            icon="gauge.with.dots.needle.33percent"
            label="Usage"
            value={t.usage}
          />
        )}
        <Fact icon="number" label="ID" value={t.session} mono />
      </Group>
    </ScrollView>
  );
}

function Fact({
  icon,
  label,
  value,
  detail,
  mono,
  first,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  value: string;
  detail?: string;
  mono?: boolean;
  first?: boolean;
}) {
  return (
    <View className="flex-row items-center gap-3 pl-4">
      <View className="w-5 items-center">
        <Icon name={icon} size={15} tone="muted-foreground" />
      </View>
      <View
        className={`min-h-[48px] flex-1 flex-row items-center gap-3 py-2.5 pr-4 ${first ? "" : "border-border border-t"}`}
      >
        <AppText className="text-[16px]">{label}</AppText>
        <View className="min-w-0 flex-1 items-end">
          <Text
            numberOfLines={2}
            className={`text-right text-muted-foreground ${mono ? "font-mono text-[13px]" : "text-[16px]"}`}
          >
            {value}
          </Text>
          {detail && (
            <AppText tone="muted" className="text-right text-[12px]">
              {detail}
            </AppText>
          )}
        </View>
      </View>
    </View>
  );
}
