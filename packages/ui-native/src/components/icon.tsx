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
