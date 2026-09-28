import { useState } from "react";
import { ScrollView, Switch, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../components/app-text";
import { Icon, useThemeColor } from "../components/icon";
import { ProviderLogo } from "../components/provider-logo";
import { EffortSlider } from "./effort-slider";
import { Group, Option, SheetHeader } from "./folder-picker";
import type { ModelPick, ModelProviderRow, ModelRow } from "./types";

/* Model + reasoning for the next turn (web: ModelPicker, Codex-style).
   Top: the neural-network effort slider of THIS model — exactly the steps
   the engine reported, none if it has no control — and Fast when the model
   has it. Below: every model with its provider's logo, searchable, grouped
   by provider. */

const EFFORT: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
export const effortLabel = (e: string) =>
  EFFORT[e] ?? e.charAt(0).toUpperCase() + e.slice(1);

/** Composer chip: "Opus 5.5 · High". */
export function modelLabel(models: ModelRow[], p: ModelPick) {
  const m = models.find((x) => x.id === p.model);
  const name = (m?.name ?? p.model).replace(/^Claude /, "");
  return p.effort ? `${name} · ${effortLabel(p.effort)}` : name;
}

export function ModelPickerSheet({
  models,
  providers,
  value,
  onPick,
  onDone,
}: {
  models: ModelRow[];
  providers: ModelProviderRow[];
  value: ModelPick;
  onPick: (p: ModelPick) => void;
  onDone: () => void;
}) {
  const insets = useSafeAreaInsets();
  const muted = useThemeColor("muted-foreground");
  const [q, setQ] = useState("");
  const cur = models.find((m) => m.id === value.model);
  const provider = (id?: string) => providers.find((p) => p.id === id);
  const efforts = cur?.efforts ?? [];
  const effort =
    value.effort && efforts.includes(value.effort)
      ? value.effort
      : cur?.defaultEffort;

  const query = q.trim().toLowerCase();
  const groups = new Map<string, ModelRow[]>();
  for (const m of models) {
    const hay =
      `${m.name} ${m.id} ${provider(m.provider)?.name ?? ""}`.toLowerCase();
    if (query && !hay.includes(query)) continue;
    groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  }

  const pickModel = (m: ModelRow) =>
    onPick({
      model: m.id,
      effort: effort && m.efforts?.includes(effort) ? effort : m.defaultEffort,
      fast: m.fast ? value.fast : undefined,
    });

  return (
    // formSheet: the ScrollView is the screen's root so the native sheet can
    // size it to the detent and hand scroll-to-edge over to the sheet.
    <ScrollView
      stickyHeaderIndices={[0]}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingBottom: Math.max(insets.bottom, 16) + 12,
        gap: 22,
      }}
    >
      <View className="-mx-4">
        <SheetHeader title="Model" onDone={onDone} />
      </View>
      <View
        className="rounded-[18px] bg-card px-4 pt-4 pb-3.5"
        style={{ borderCurve: "continuous" }}
      >
        <AppText size="xs" tone="muted" className="text-center">
          Reasoning
        </AppText>
        <AppText
          tone="none"
          className={`mt-0.5 mb-3 text-center font-semibold text-[22px] leading-7 ${effort ? "text-reasoning" : "text-muted-foreground"}`}
        >
          {effort ? effortLabel(effort) : "Not adjustable"}
        </AppText>
        {efforts.length > 1 ? (
          <EffortSlider
            efforts={efforts}
            index={effort ? efforts.indexOf(effort) : -1}
            label={effortLabel}
            onPick={(e) => onPick({ ...value, effort: e })}
          />
        ) : (
          <AppText size="xs" tone="muted" className="text-center">
            {efforts.length === 1
              ? "This model has one reasoning level."
              : "This model has no reasoning control."}
          </AppText>
        )}
        {cur && (
          <View className="mt-3.5 flex-row items-center gap-2.5 border-border border-t pt-3">
            <ProviderLogo slug={provider(cur.provider)?.logo} size={18} />
            <View className="min-w-0 flex-1">
              <AppText size="sm" weight="medium" numberOfLines={1}>
                {cur.name}
              </AppText>
              <AppText size="xs" tone="muted" numberOfLines={1}>
                {provider(cur.provider)?.name ?? cur.provider}
              </AppText>
            </View>
          </View>
        )}
        {cur?.fast && (
          <View className="mt-3.5 flex-row items-center gap-2.5 border-border border-t pt-3">
            <Icon name="bolt.fill" size={14} tone="warning" />
            <View className="flex-1">
              <AppText size="sm" weight="medium">
                Fast mode
              </AppText>
              <AppText size="xs" tone="muted">
                Quicker answers, higher cost.
              </AppText>
            </View>
            <Switch
              value={!!value.fast}
              onValueChange={(v) => onPick({ ...value, effort, fast: v })}
            />
          </View>
        )}
      </View>

      <View
        className="h-10 flex-row items-center gap-2 rounded-xl bg-muted px-3"
        style={{ borderCurve: "continuous" }}
      >
        <Icon name="magnifyingglass" size={14} tone="muted-foreground" />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search models"
          placeholderTextColor={muted}
          autoCorrect={false}
          autoCapitalize="none"
          className="flex-1 text-[16px] text-foreground"
        />
      </View>

      {[...groups.entries()].map(([p, items]) => (
        <Group key={p} title={provider(p)?.name ?? p}>
          {items.map((m, i) => (
            <Option
              key={m.id}
              first={i === 0}
              lead={<ProviderLogo slug={provider(p)?.logo} />}
              title={m.name}
              detail={
                m.efforts?.length
                  ? `${m.efforts.length} reasoning levels`
                  : "No reasoning control"
              }
              on={m.id === value.model}
              trailing={
                m.fast ? (
                  <Icon name="bolt" size={12} tone="muted-foreground" />
                ) : undefined
              }
              onPress={() => pickModel(m)}
            />
          ))}
        </Group>
      ))}
      {groups.size === 0 && (
        <AppText size="sm" tone="muted" className="text-center">
          No model found.
        </AppText>
      )}
      <AppText size="xs" tone="muted" className="px-2 text-center">
        Applies from the next turn.
      </AppText>
    </ScrollView>
  );
}
