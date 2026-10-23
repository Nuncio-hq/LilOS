import { type SFSymbol, SymbolView } from "expo-symbols";
import { useThemeColor } from "../../components/icon";

/** An SF Symbol in a v3 token colour. The shared `Icon` only knows the old
    theme tones; the v3 inks and status inks live under other variable names. */
export function Glyph({
  name,
  token = "ink-2",
  size = 14,
  weight = "regular",
}: {
  name: SFSymbol;
  /** A colour variable without the `--color-` prefix: "ink-2", "paper", "st-stuck-ink". */
  token?: string;
  size?: number;
  weight?: "regular" | "medium" | "semibold" | "bold";
}) {
  const color = useThemeColor(token);
  return (
    <SymbolView
      name={name}
      size={size}
      weight={weight}
      tintColor={color}
      resizeMode="scaleAspectFit"
    />
  );
}
