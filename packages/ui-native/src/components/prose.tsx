/* biome-ignore-all lint/suspicious/noArrayIndexKey: static text split into pieces; the order never changes. */
import * as Clipboard from "expo-clipboard";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, Text, View } from "react-native";
import { type CodeSpan, highlight } from "./code-highlight";
import { Icon, useThemeColor } from "./icon";
import { langName, type ProseBlock, parseProse } from "./prose-blocks";

/* Agent text: paragraphs, "- " bullets, **bold**, `code` and fenced code
   blocks — the slice of markdown the engine actually sends in short
   replies. The web renders full markdown (streamdown); mobile keeps a
   bespoke renderer (D-#259) so streaming states stay ours: an unclosed
   fence is a code block in progress, never raw backticks. */
export function Prose({
  text,
  size = "base",
}: {
  text: string;
  size?: "base" | "sm";
}) {
  const cls =
    size === "sm"
      ? "text-[14.5px] leading-[21px]"
      : "text-[16px] leading-[24px]";
  return (
    <View className="gap-2.5">
      {parseProse(text).map((b, i) => {
        if (b.kind === "code")
          return <CodeBlock key={i} block={b} small={size === "sm"} />;
        if (b.kind === "bullets")
          return (
            <View key={i} className="gap-1.5">
              {b.items.map((item, j) => (
                <View key={j} className="flex-row gap-2.5 pr-2">
                  <Text className={`${cls} text-muted-foreground`}>•</Text>
                  <Inline text={closeOpen(item)} className={`${cls} flex-1`} />
                </View>
              ))}
            </View>
          );
        return <Inline key={i} text={closeOpen(b.text)} className={cls} />;
      })}
    </View>
  );
}

function Inline({ text, className }: { text: string; className: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <Text className={`text-foreground ${className}`}>
      {parts.map((p, i) =>
        p.startsWith("**") ? (
          <Text key={i} className="font-semibold">
            {p.slice(2, -2)}
          </Text>
        ) : p.startsWith("`") ? (
          <Text key={i} className="font-mono text-[14px] text-accent-text">
            {p.slice(1, -1)}
          </Text>
        ) : (
          p
        ),
      )}
    </Text>
  );
}

/* A fenced block: one tinted panel, a single header row (friendly language
   name left, Copy right — flips to Copied), code in Menlo inside its own
   horizontal scroller so long lines never push the thread sideways.
   Long-press anywhere on the code copies it too. */
function CodeBlock({
  block,
  small,
}: {
  block: Extract<ProseBlock, { kind: "code" }>;
  small: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void Clipboard.setStringAsync(block.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const palette = {
    "code-keyword": useThemeColor("code-keyword"),
    "code-string": useThemeColor("code-string"),
    "code-comment": useThemeColor("code-comment"),
    "code-number": useThemeColor("code-number"),
    "code-title": useThemeColor("code-title"),
    "code-attr": useThemeColor("code-attr"),
    "code-builtin": useThemeColor("code-builtin"),
    "code-addition": useThemeColor("code-addition"),
    "code-deletion": useThemeColor("code-deletion"),
  };
  const lines = codeLines(highlight(block.code, block.lang));
  return (
    <View
      className="overflow-hidden rounded-[14px] bg-card"
      style={{ borderCurve: "continuous" }}
    >
      <View className="h-8 flex-row items-center justify-between pl-3 pr-2">
        <Text className="font-mono text-[11px] text-muted-foreground">
          {langName(block.lang)}
          {!block.closed && " …"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? "Copied" : "Copy code"}
          onPress={copy}
          hitSlop={6}
          className="flex-row items-center gap-1 active:opacity-60"
        >
          <Icon
            name={copied ? "checkmark" : "doc.on.doc"}
            size={11}
            tone="muted-foreground"
          />
          <Text className="text-[11px] text-muted-foreground">
            {copied ? "Copied" : "Copy"}
          </Text>
        </Pressable>
      </View>
      <View className="h-px bg-muted-strong/40" />
      <ScrollView horizontal bounces={false}>
        <Pressable onLongPress={copy} accessibilityLabel="Copy code">
          <View className="px-3 py-2">
            {lines.map((spans, i) => (
              <Text
                key={i}
                className={`font-mono text-foreground ${
                  small
                    ? "text-[12px] leading-[17px]"
                    : "text-[13px] leading-[19px]"
                }`}
              >
                {spans.length ? (
                  spans.map((span, j) => (
                    <Text key={j} style={spanStyle(span, palette)}>
                      {span.text}
                    </Text>
                  ))
                ) : (
                  <Text> </Text>
                )}
              </Text>
            ))}
          </View>
        </Pressable>
      </ScrollView>
    </View>
  );
}

type CodePalette = Record<string, string | undefined>;

function spanStyle(span: CodeSpan, palette: CodePalette) {
  const style: {
    color?: string;
    fontWeight?: "semibold";
    fontStyle?: "italic";
  } = {};
  for (const cls of span.classes) {
    for (const [match, token] of HLJS_TONES) {
      if (match.test(cls)) {
        const color = palette[token];
        if (color) style.color = color;
      }
    }
    if (cls === "hljs-strong") style.fontWeight = "semibold";
    if (cls === "hljs-emphasis") style.fontStyle = "italic";
  }
  return style;
}

const HLJS_TONES: [RegExp, string][] = [
  [/keyword|selector-tag|template-tag|doctag/, "code-keyword"],
  [/string|regexp|char|symbol|template-string/, "code-string"],
  [/comment|quote/, "code-comment"],
  [/number|literal/, "code-number"],
  [/title|section|name|selector-id|selector-class|selector-attr/, "code-title"],
  [/attr|attribute|variable|template-variable|params/, "code-attr"],
  [/built_in|type|meta|link/, "code-builtin"],
  [/addition/, "code-addition"],
  [/deletion/, "code-deletion"],
];

/** Flattened highlight spans → per-line span lists (RN <Text> can't be
    asked to not wrap, so each visual line is its own Text row). */
function codeLines(spans: CodeSpan[]): CodeSpan[][] {
  const lines: CodeSpan[][] = [[]];
  for (const span of spans) {
    const pieces = span.text.split("\n");
    pieces.forEach((piece, i) => {
      if (i > 0) lines.push([]);
      if (piece) lines[lines.length - 1].push({ ...span, text: piece });
    });
  }
  // A trailing newline would draw one phantom empty row.
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

/* Mid-stream the text can end inside **bold** or `code`; drop the dangling
   opener so the reader never sees raw markers. Fences never reach here —
   parseProse already owns their content. */
function closeOpen(text: string) {
  let t = text;
  if ((t.match(/\*\*/g) ?? []).length % 2) {
    const i = t.lastIndexOf("**");
    t = t.slice(0, i) + t.slice(i + 2);
  }
  if ((t.match(/`/g) ?? []).length % 2) {
    const i = t.lastIndexOf("`");
    t = t.slice(0, i) + t.slice(i + 1);
  }
  return t;
}

/** Markdown → one plain line, for previews. */
export function plain(text: string) {
  return parseProse(text)
    .map((b) => {
      if (b.kind === "code") return b.code;
      if (b.kind === "bullets") return b.items.join(" ");
      return b.text;
    })
    .join(" ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Soft breathing opacity for live things (Thinking…, a running step). */
export function Pulse({ children }: { children: ReactNode }) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, {
          toValue: 0.4,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(v, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return <Animated.View style={{ opacity: v }}>{children}</Animated.View>;
}
