import { ScrollView, Text, View } from "react-native";
import { T } from "../kit";
import { Glyph } from "./glyph";
import type { AttachmentVM } from "./types";

/* What a reply carries besides prose: a PR, a diff, an image, a sheet.
   Hairline outline, no fills but the code's own soft ground. */

const SHELL = "overflow-hidden rounded-xl border border-rule";

function Counts({ add, del }: { add: number; del: number }) {
  return (
    <Text className="font-mono text-[12.5px] text-ink-2">
      +{add} −{del}
    </Text>
  );
}

const LINE = {
  add: { cls: "bg-paper-soft text-ink", mark: "+" },
  del: { cls: "text-ink-3 line-through", mark: "−" },
  ctx: { cls: "text-ink-2", mark: " " },
} as const;

function Item({ a }: { a: AttachmentVM }) {
  if (a.kind === "pr") {
    return (
      <View
        className={`${SHELL} flex-row items-center gap-3 px-3.5 py-3`}
        accessibilityLabel={`Pull request ${a.num} ${a.title}`}
      >
        <Glyph name="arrow.triangle.pull" token="ink-2" size={16} />
        <View className="flex-1 gap-0.5">
          <T variant="small" numberOfLines={2} className="font-semibold">
            {`#${a.num} ${a.title}`}
          </T>
          <View className="flex-row items-center gap-2">
            <T
              variant="caption"
              tone="ink3"
              numberOfLines={1}
              className="shrink"
            >
              {a.branch}
            </T>
            <Counts add={a.add} del={a.del} />
          </View>
        </View>
      </View>
    );
  }
  if (a.kind === "diff") {
    return (
      <View className={SHELL}>
        <View className="flex-row items-center gap-2 border-rule border-b px-3.5 py-2.5">
          <Text
            className="shrink font-mono text-[12.5px] text-ink"
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {a.path}
          </Text>
          <Counts add={a.add} del={a.del} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="py-1.5">
            {a.lines.map((l) => (
              <Text
                key={l.key}
                className={`px-3.5 font-mono text-[12.5px] leading-[19px] ${LINE[l.kind].cls}`}
              >
                {`${LINE[l.kind].mark} ${l.text}`}
              </Text>
            ))}
          </View>
        </ScrollView>
      </View>
    );
  }
  if (a.kind === "image") {
    return (
      <View
        className={`${SHELL} flex-row items-center gap-3 px-3.5 py-3`}
        accessibilityLabel={`Image ${a.label}`}
      >
        <Glyph name="photo" token="ink-2" size={16} />
        <T variant="small" numberOfLines={2} className="flex-1">
          {a.label}
        </T>
        <T variant="caption" tone="ink3">
          Image
        </T>
      </View>
    );
  }
  return (
    <View
      className={`${SHELL} flex-row items-center gap-3 px-3.5 py-3`}
      accessibilityLabel={`Sheet ${a.name}`}
    >
      <Glyph name="tablecells" token="ink-2" size={16} />
      <T variant="small" numberOfLines={1} className="flex-1 font-semibold">
        {a.name}
      </T>
      <T variant="caption" tone="ink3">
        {a.rows === 1 ? "1 row" : `${a.rows} rows`}
      </T>
    </View>
  );
}

export function Attachments({ items }: { items: AttachmentVM[] }) {
  if (items.length === 0) return null;
  return (
    <View className="gap-2.5">
      {items.map((a) => (
        <Item key={a.key} a={a} />
      ))}
    </View>
  );
}
