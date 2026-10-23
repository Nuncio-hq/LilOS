/* biome-ignore-all lint/suspicious/noArrayIndexKey: static text split into pieces; the order never changes. */
import { ScrollView, Text, View } from "react-native";
import {
  columnWidths,
  langName,
  type ProseBlock,
  parseProse,
} from "../../components/prose-blocks";

/* An agent's markdown in the v3 look: ink on paper, no colour (the shared
   `Prose` tints code teal and draws on the old theme). The parsing is the
   shared `parseProse`, so a fence still streams as a code block in progress. */

/** Mid-stream a reply can end inside `code` or **bold**: drop the dangling
    opener so nobody reads raw markers. */
function closeOpen(text: string): string {
  let out = text;
  if ((out.match(/`/g)?.length ?? 0) % 2 === 1) {
    const i = out.lastIndexOf("`");
    out = out.slice(0, i) + out.slice(i + 1);
  }
  if ((out.match(/\*\*/g)?.length ?? 0) % 2 === 1) {
    const i = out.lastIndexOf("**");
    out = out.slice(0, i) + out.slice(i + 2);
  }
  return out;
}

const BODY = "text-[16px] leading-[24px] text-ink";

function Inline({ text, className }: { text: string; className: string }) {
  const parts = closeOpen(text)
    .split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g)
    .filter(Boolean);
  return (
    <Text className={className}>
      {parts.map((p, i) =>
        p.startsWith("**") ? (
          <Text key={i} className="font-semibold">
            {p.slice(2, -2)}
          </Text>
        ) : p.startsWith("*") && p.length > 2 ? (
          <Text key={i} className="italic">
            {p.slice(1, -1)}
          </Text>
        ) : p.startsWith("`") ? (
          <Text key={i} className="bg-paper-soft font-mono text-[14px]">
            {p.slice(1, -1)}
          </Text>
        ) : (
          <Text key={i}>{p}</Text>
        ),
      )}
    </Text>
  );
}

function Code({ block }: { block: Extract<ProseBlock, { kind: "code" }> }) {
  return (
    <View className="overflow-hidden rounded-xl bg-paper-soft">
      <Text className="px-3.5 pt-2.5 text-[12px] text-ink-3">
        {langName(block.lang)}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 14,
          paddingTop: 4,
          paddingBottom: 12,
        }}
      >
        <Text className="font-mono text-[13px] leading-[19px] text-ink">
          {block.code}
        </Text>
      </ScrollView>
    </View>
  );
}

function Table({ block }: { block: Extract<ProseBlock, { kind: "table" }> }) {
  const widths = columnWidths(block.header, block.rows);
  const align = (i: number) =>
    block.align[i] === "right"
      ? "text-right"
      : block.align[i] === "center"
        ? "text-center"
        : "text-left";
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View>
        <View className="flex-row border-rule border-b">
          {block.header.map((h, i) => (
            <Text
              key={i}
              className={`px-2 py-1.5 font-semibold text-[14px] text-ink ${align(i)}`}
              style={{ width: widths[i] }}
            >
              {h}
            </Text>
          ))}
        </View>
        {block.rows.map((row, r) => (
          <View key={r} className="flex-row border-rule border-b">
            {block.header.map((_, i) => (
              <Text
                key={i}
                className={`px-2 py-1.5 text-[14px] text-ink ${align(i)}`}
                style={{ width: widths[i] }}
              >
                {row[i] ?? ""}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

export function V3Prose({ text }: { text: string }) {
  return (
    <View className="gap-2.5">
      {parseProse(text).map((b, i) => {
        if (b.kind === "code") return <Code key={i} block={b} />;
        if (b.kind === "table") return <Table key={i} block={b} />;
        if (b.kind === "bullets")
          return (
            <View key={i} className="gap-1.5">
              {b.items.map((item, j) => (
                <View key={j} className="flex-row gap-2.5 pr-2">
                  <Text className={`${BODY} text-ink-3`}>•</Text>
                  <Inline text={item} className={`${BODY} flex-1`} />
                </View>
              ))}
            </View>
          );
        return <Inline key={i} text={b.text} className={BODY} />;
      })}
    </View>
  );
}
