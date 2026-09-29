import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../components/app-text";
import { Pill } from "../components/bits";
import { Icon } from "../components/icon";
import { Pulse } from "../components/prose";
import { Rise } from "../components/rise";
import { Group, SheetHeader } from "./folder-picker";
import type { MacDir } from "./types";

/* Pick any folder on the paired Mac from the phone (web: AddFolderDialog),
   like browsing in Files: start at home, tap a folder to go in, back to go
   up, "Use this folder" to run sessions there. Git repos carry their branch.
   At home, the Mac's git repos it found are listed first. */

const nameOf = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export function MacFolderBrowser({
  home = "~",
  macName,
  found,
  readDir,
  onUse,
  onDone,
}: {
  home?: string;
  macName: string;
  /** Repos found on the Mac, shown at home. */
  found?: { path: string; branch?: string }[];
  /** Lists one folder; null = not reachable. */
  readDir: (path: string) => Promise<MacDir | null>;
  onUse: (path: string, dir: MacDir) => void;
  onDone: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [path, setPath] = useState(home);
  const [dir, setDir] = useState<MacDir | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setDir(undefined);
    readDir(path).then((d) => live && setDir(d));
    return () => {
      live = false;
    };
  }, [path, readDir]);
  const atHome = path === home;
  const up = () => setPath(path.slice(0, path.lastIndexOf("/")) || home);

  return (
    <View className="flex-1">
      <ScrollView
        stickyHeaderIndices={[0]}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: Math.max(insets.bottom, 16) + 84,
          gap: 22,
        }}
      >
        <View className="-mx-4 bg-background">
          <SheetHeader
            title={atHome ? macName : nameOf(path)}
            onDone={onDone}
            left={
              !atHome && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Back"
                  onPress={up}
                  hitSlop={8}
                  className="flex-row items-center gap-0.5 active:opacity-60"
                >
                  <Icon
                    name="chevron.left"
                    size={15}
                    weight="semibold"
                    tone="primary"
                  />
                  <AppText tone="none" className="text-primary">
                    Back
                  </AppText>
                </Pressable>
              )
            }
          />
          <Text
            numberOfLines={1}
            className="px-4 pb-2 text-center font-mono text-[12px] text-muted-foreground"
          >
            {path}
          </Text>
        </View>

        {atHome && !!found?.length && (
          <Group title="Found on this Mac">
            {found.map((r, i) => (
              <Row
                key={r.path}
                first={i === 0}
                name={nameOf(r.path)}
                detail={r.path}
                branch={r.branch}
                onPress={() => setPath(r.path)}
              />
            ))}
          </Group>
        )}

        {dir === undefined ? (
          <Pulse>
            <AppText tone="muted" className="px-2">
              Loading…
            </AppText>
          </Pulse>
        ) : dir === null ? (
          <AppText tone="muted" className="px-2">
            Can't reach the Mac right now.
          </AppText>
        ) : dir.folders.length === 0 ? (
          <AppText tone="muted" className="px-2">
            No folders inside.
          </AppText>
        ) : (
          <Rise>
            <Group title={atHome ? "Home" : undefined}>
              {dir.folders.map((f, i) => (
                <Row
                  key={f.path}
                  first={i === 0}
                  name={f.name}
                  branch={f.branch}
                  onPress={() => setPath(f.path)}
                />
              ))}
            </Group>
          </Rise>
        )}
      </ScrollView>

      {dir && !atHome && (
        <View
          className="absolute inset-x-0 bottom-0 items-center gap-1.5 px-4 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 16) + 4 }}
        >
          <Pill
            label={`Use “${nameOf(path)}”`}
            onPress={() => onUse(path, dir)}
          />
          <AppText size="xs" tone="muted">
            {dir.branch
              ? `Git repo · ${dir.branch}`
              : "Not a git repo · edits land here directly"}
          </AppText>
        </View>
      )}
    </View>
  );
}

function Row({
  name,
  detail,
  branch,
  first,
  onPress,
}: {
  name: string;
  detail?: string;
  branch?: string;
  first: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={branch ? `${name}, git repo on ${branch}` : name}
      onPress={onPress}
      className="flex-row items-center gap-3 pl-4 active:bg-muted"
    >
      <View className="w-5 items-center">
        <Icon
          name={branch ? "arrow.triangle.branch" : "folder.fill"}
          size={15}
          tone={branch ? "primary" : "subtle-foreground"}
        />
      </View>
      <View
        className={`min-h-[50px] flex-1 flex-row items-center gap-2 py-2.5 pr-4 ${first ? "" : "border-border border-t"}`}
      >
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-[16px] text-foreground">
            {name}
          </Text>
          {detail && (
            <Text
              numberOfLines={1}
              className="font-mono text-[12px] text-muted-foreground"
            >
              {detail}
            </Text>
          )}
        </View>
        {branch && (
          <View className="rounded-full bg-accent-soft px-2 py-0.5">
            <Text className="font-mono text-[11.5px] text-accent-text">
              {branch}
            </Text>
          </View>
        )}
        <Icon
          name="chevron.right"
          size={11}
          weight="semibold"
          tone="muted-foreground"
        />
      </View>
    </Pressable>
  );
}
