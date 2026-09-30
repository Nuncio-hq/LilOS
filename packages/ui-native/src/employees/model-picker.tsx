import { useState } from "react";
import { ScrollView, Switch, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../components/app-text";
import { Icon, useThemeColor } from "../components/icon";
import { ProviderLogo } from "../components/provider-logo";
import { EffortSlider } from "./effort-slider";
import { Group, Option, SheetHeader } from "./folder-picker";
import {
  effortIndex,
  effortOf,
  findModel,
  modelKeyOf,
  nextModelPick,
  pickableModels,
} from "./model-rules";
import type {
  ModelPick,
  ModelProviderRow,
  ModelRow,
  ModelVisibility,
} from "./types";

/* Model + reasoning for the next turn (web: ModelPicker, Codex-style).
   Top: the neural-network effort slider of THIS model — exactly the steps
   the engine reported, none if it has no control — and Fast when the model
   has it. Below: every model with its provider's logo, searchable, grouped
   by provider — minus the shared hide list the Mac's "Edit models" writes
   (the session's own pick always stays, merged in even when the catalog
   omits it). The rules live in ./model-rules; this is the renderer. */

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
  const m = findModel(models, p);
  const name = (m?.name ?? p.model).replace(/^Claude /, "");
  return p.effort ? `${name} · ${effortLabel(p.effort)}` : name;
}

export function ModelPickerSheet({
  models,
  providers,
  value,
  visibility,
  onPick,
  onDone,
}: {
  models: ModelRow[];
  providers: ModelProviderRow[];
  value: ModelPick;
  /** The shared "Edit models" hide list — same rows the Mac shows (#160). */
  visibility?: ModelVisibility;
  onPick: (p: ModelPick) => void;
  onDone: () => void;
}) {
  const insets = useSafeAreaInsets();
  const muted = useThemeColor("muted-foreground");
  const [q, setQ] = useState("");
  /* The picker's effective list: engine rows minus hidden ones, plus the
     session's own pick merged in when the catalog omits it (#160 AC-1). */
  const shown = pickableModels(models, visibility, value);
  const cur = findModel(shown, value);
  const provider = (id?: string) => providers.find((p) => p.id === id);
  const efforts = cur?.efforts ?? [];
  const effort = effortOf(value, cur);

  const query = q.trim().toLowerCase();
  /* Provider groups in the engine's own order (an unknown provider sorts
     after the declared ones); empty groups don't render. */
  const groups = new Map<string, ModelRow[]>();
  for (const p of providers) groups.set(p.id, []);
  for (const m of shown) {
    const hay =
      `${m.name} ${m.id} ${provider(m.provider)?.name ?? ""}`.toLowerCase();
    if (query && !hay.includes(query)) continue;
    groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  }

  const pickModel = (m: ModelRow) => {
    /* A merged notInList row is a marker, not a pick — the engine's catalog
       doesn't offer it (web: only Refresh brings it back). */
    if (m.notInList) return;
    onPick(nextModelPick({ effort, fast: value.fast }, m));
  };

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
          {effort
            ? effortLabel(effort)
            : efforts.length
              ? "Engine default"
              : "Not adjustable"}
        </AppText>
        {efforts.length > 1 ? (
          <EffortSlider
            efforts={efforts}
            index={effortIndex(effort, efforts)}
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

      {[...groups.entries()]
        .filter(([, items]) => items.length > 0)
        .map(([p, items]) => (
          <Group key={p || "other"} title={(provider(p)?.name ?? p) || "Other"}>
            {items.map((m, i) => (
              <Option
                key={modelKeyOf(m)}
                first={i === 0}
                lead={<ProviderLogo slug={provider(p)?.logo} />}
                title={m.name}
                detail={
                  m.notInList
                    ? "Not in list"
                    : m.efforts?.length
                      ? `${m.efforts.length} reasoning levels`
                      : "No reasoning control"
                }
                on={m === cur}
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
