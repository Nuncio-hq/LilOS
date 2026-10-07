import type { SFSymbol } from "expo-symbols";
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../components/app-text";
import { Icon } from "../components/icon";
import type { FolderOption, WorkspacePick } from "./types";

/* Where a new thread runs (web: WorkspacePicker) — folder first, then how
   it touches git: a new worktree off a branch (the default), continue an
   existing workstream, or edit a branch in place. "No folder" = chat only.
   Presented as a native form sheet; each pick applies at once. */
export function FolderPickerSheet({
  folders,
  pick,
  onPick,
  onDone,
  onBrowse,
}: {
  folders: FolderOption[];
  pick: WorkspacePick;
  onPick: (p: WorkspacePick) => void;
  onDone: () => void;
  /** "Other folder on the Mac…" — browse the Mac's folders. Absent = no row. */
  onBrowse?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const f = folders.find((x) => x.id === pick.folder);
  return (
    // formSheet: the ScrollView is the screen's root so the native sheet can
    // size it to the detent and hand scroll-to-edge over to the sheet.
    <ScrollView
      stickyHeaderIndices={[0]}
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingBottom: Math.max(insets.bottom, 16) + 12,
        gap: 22,
      }}
    >
      <View className="-mx-4">
        <SheetHeader title="Run this thread in" onDone={onDone} />
      </View>
      <Group>
        {folders.map((x, i) => (
          <Option
            key={x.id}
            first={i === 0}
            icon="folder"
            title={x.project}
            detail={x.path}
            mono
            on={pick.folder === x.id}
            onPress={() =>
              onPick({
                folder: x.id,
                base: x.branches[0] ?? "",
                mode: x.probing || x.branches.length ? "new" : "direct",
              })
            }
          />
        ))}
        <Option
          icon="bubble.left"
          title="No folder"
          on={!pick.folder}
          onPress={() => onPick({ folder: null, base: "", mode: "direct" })}
        />
        {onBrowse && (
          <Option
            icon="macbook"
            title="Other folder on the Mac…"
            onPress={onBrowse}
            trailing={
              <Icon
                name="chevron.right"
                size={11}
                weight="semibold"
                tone="muted-foreground"
              />
            }
          />
        )}
      </Group>

      {f?.missing && (
        <AppText size="xs" tone="muted" className="px-2">
          That folder is no longer on this Mac — pick another.
        </AppText>
      )}

      {f && !f.missing && f.probing && (
        <AppText size="xs" tone="muted" className="px-2">
          Checking git…
        </AppText>
      )}

      {f && !f.missing && !f.probing && f.branches.length === 0 && (
        <AppText size="xs" tone="muted" className="px-2">
          Not a git repo: no branches or worktrees, edits land in the folder
          directly.
        </AppText>
      )}

      {f && f.branches.length > 0 && (
        <>
          <Group title="New workstream from" note="New branch + worktree">
            {f.branches.map((b, i) => (
              <Option
                key={b}
                first={i === 0}
                icon="arrow.triangle.branch"
                title={b}
                mono
                on={pick.mode === "new" && pick.base === b}
                onPress={() =>
                  onPick({
                    ...pick,
                    mode: "new",
                    base: b,
                    existing: undefined,
                  })
                }
              />
            ))}
          </Group>
          {f.workstreams.length > 0 && (
            <Group title="Continue a workstream">
              {f.workstreams.map((w, i) => (
                <Option
                  key={w.branch}
                  first={i === 0}
                  icon="arrow.triangle.pull"
                  title={w.branch}
                  detail={`${w.path}${w.from ? ` · from ${w.from}` : ""}`}
                  mono
                  on={pick.mode === "existing" && pick.existing === w.branch}
                  onPress={() =>
                    onPick({
                      ...pick,
                      mode: "existing",
                      existing: w.branch,
                      base: w.from ?? "",
                    })
                  }
                />
              ))}
            </Group>
          )}
          <Group title="No worktree">
            {f.branches.map((b, i) => (
              <Option
                key={b}
                first={i === 0}
                icon="pencil"
                title={`Edit ${b} directly`}
                on={pick.mode === "direct" && pick.base === b}
                onPress={() =>
                  onPick({
                    ...pick,
                    mode: "direct",
                    base: b,
                    existing: undefined,
                  })
                }
              />
            ))}
          </Group>
        </>
      )}
      <AppText size="xs" tone="muted" className="px-2 text-center">
        {hint(f, pick)}
      </AppText>
    </ScrollView>
  );
}

/** Chip label for the composer: "LilOS · main", "LilOS · lil-3-monorepo", "No folder". */
export function pickLabel(folders: FolderOption[], p: WorkspacePick) {
  const f = folders.find((x) => x.id === p.folder);
  if (!f) return "No folder";
  if (f.probing) return `${f.project} · …`;
  if (!f.branches.length) return f.project;
  const b = p.mode === "existing" ? p.existing : p.base || f.branches[0];
  return `${f.project} · ${b}`;
}

const hint = (f: FolderOption | undefined, p: WorkspacePick) =>
  !f
    ? "Chat only. No files, no git."
    : !f.branches.length
      ? `Runs in ${f.path}. Edits land there directly.`
      : p.mode === "new"
        ? `Runs in a new worktree off ${p.base}. Your checkout stays untouched.`
        : p.mode === "existing"
          ? `Continues in ${f.workstreams.find((w) => w.branch === p.existing)?.path ?? "the worktree"}.`
          : `Edits land on ${p.base} in ${f.path} directly.`;

/* ── Shared sheet parts (also used by the model picker) ─────────────────── */

export function SheetHeader({
  title,
  onDone,
  left,
}: {
  title: string;
  onDone: () => void;
  left?: ReactNode;
}) {
  return (
    <View className="flex-row items-center px-4 pt-4 pb-3">
      <View className="w-16">{left}</View>
      <AppText weight="semibold" className="flex-1 text-center">
        {title}
      </AppText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Done"
        onPress={onDone}
        hitSlop={8}
        className="w-16 items-end active:opacity-60"
      >
        <AppText weight="semibold" tone="none" className="text-primary">
          Done
        </AppText>
      </Pressable>
    </View>
  );
}

export function Group({
  title,
  note,
  children,
}: {
  title?: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <View className="gap-1.5">
      {title && (
        <View className="flex-row items-baseline gap-2 px-2">
          <AppText size="xs" tone="muted" weight="semibold">
            {title}
          </AppText>
          {note && (
            <AppText size="xs" tone="muted">
              {note}
            </AppText>
          )}
        </View>
      )}
      <View
        className="overflow-hidden rounded-[18px] bg-card"
        style={{ borderCurve: "continuous" }}
      >
        {children}
      </View>
    </View>
  );
}

export function Option({
  icon,
  lead,
  title,
  detail,
  mono,
  on,
  first,
  trailing,
  onPress,
}: {
  icon?: SFSymbol;
  lead?: ReactNode;
  title: string;
  detail?: string;
  mono?: boolean;
  on?: boolean;
  first?: boolean;
  trailing?: ReactNode;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
      accessibilityLabel={title}
      onPress={onPress}
      className="flex-row items-center gap-3 pl-4 active:bg-muted"
    >
      <View className="w-5 items-center">
        {lead ??
          (icon && (
            <Icon
              name={icon}
              size={15}
              tone={on ? "primary" : "subtle-foreground"}
            />
          ))}
      </View>
      <View
        className={`min-h-[50px] flex-1 flex-row items-center gap-2 py-2.5 pr-4 ${first === false || first === undefined ? "border-border border-t" : ""}`}
      >
        <View className="min-w-0 flex-1">
          <Text
            numberOfLines={1}
            className={`text-foreground ${mono && !detail ? "font-mono text-[14.5px]" : "text-[16px]"} ${on ? "font-semibold" : ""}`}
          >
            {title}
          </Text>
          {detail && (
            <Text
              numberOfLines={1}
              className={`mt-0.5 text-muted-foreground ${mono ? "font-mono text-[11.5px]" : "text-[13px]"}`}
            >
              {detail}
            </Text>
          )}
        </View>
        {trailing}
        {on && <Icon name="checkmark" size={14} weight="bold" tone="primary" />}
      </View>
    </Pressable>
  );
}
