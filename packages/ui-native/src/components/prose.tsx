/* biome-ignore-all lint/suspicious/noArrayIndexKey: static text split into pieces; the order never changes. */
import { type ReactNode, useEffect, useRef } from "react";
import { Animated, Text, View } from "react-native";

/* Agent text: paragraphs, "- " bullets, **bold** and `code` — the small
   slice of markdown the engine actually sends in short replies. The web
   renders full markdown (streamdown); this is enough for the prototype. */
export function Prose({
  text,
  size = "base",
}: {
  text: string;
  size?: "base" | "sm";
}) {
  const blocks = closeOpen(text).split(/\n{2,}/);
  const cls =
    size === "sm"
      ? "text-[14.5px] leading-[21px]"
      : "text-[16px] leading-[24px]";
  return (
    <View className="gap-2.5">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*[-*] /.test(l)))
          return (
            <View key={i} className="gap-1.5">
              {lines.map((l, j) => (
                <View key={j} className="flex-row gap-2.5 pr-2">
                  <Text className={`${cls} text-muted-foreground`}>•</Text>
                  <Inline
                    text={l.replace(/^\s*[-*] /, "")}
                    className={`${cls} flex-1`}
                  />
                </View>
              ))}
            </View>
          );
        return <Inline key={i} text={b} className={cls} />;
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

/* Mid-stream the text can end inside **bold** or `code`; drop the dangling
   opener so the reader never sees raw markers. */
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
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*] /gm, "")
    .replace(/\s*\n+\s*/g, " ");
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
