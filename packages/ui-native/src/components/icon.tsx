import { type SFSymbol, SymbolView } from "expo-symbols";
import { useCSSVariable } from "uniwind";

export type IconTone =
  | "foreground"
  | "muted-foreground"
  | "primary-foreground"
  | "accent-text"
  | "destructive"
  | "success"
  | "warning"
  | "primary"
  | "subtle-foreground"
  | "work"
  | "merged";

/* The attachment chip's type glyph — mirrors the web chip's iconFor so a
   PDF vs a zip reads differently at a glance; paperclip is the catch-all. */
export function attachmentIcon(mimeType: string): SFSymbol {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("audio/")) return "waveform";
  if (mime.startsWith("video/")) return "film";
  if (/zip|tar|gzip|7z|rar|archive|compressed/.test(mime)) return "doc.zipper";
  if (/json|javascript|typescript|xml|yaml|x-sh|sql|graphql|wasm/.test(mime))
    return "chevron.left.forwardslash.chevron.right";
  if (/csv|excel|spreadsheet/.test(mime)) return "tablecells";
  if (mime.startsWith("text/") || /pdf|document|msword|rtf/.test(mime))
    return "doc.text";
  return "paperclip";
}

/* SF Symbols tinted from the theme's CSS variables (light/dark aware). */
export function Icon({
  name,
  size = 20,
  tone = "foreground",
  weight = "regular",
}: {
  name: SFSymbol;
  size?: number;
  tone?: IconTone;
  weight?: "regular" | "medium" | "semibold" | "bold";
}) {
  const color = useCSSVariable(`--color-${tone}`);
  return (
    <SymbolView
      name={name}
      size={size}
      weight={weight}
      tintColor={typeof color === "string" ? color : undefined}
      resizeMode="scaleAspectFit"
    />
  );
}

export function useThemeColor(token: string): string | undefined {
  const c = useCSSVariable(`--color-${token}`);
  return typeof c === "string" ? c : undefined;
}
