import { Text, type TextProps } from "react-native";

type Tone =
  | "default"
  | "muted"
  | "destructive"
  | "success"
  | "warning"
  | "inverse"
  /** No color class: the caller's className sets it (avoids two competing text-* colors). */
  | "none";
type Size = "xs" | "sm" | "base" | "lg" | "title" | "hero";

const TONE: Record<Tone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  destructive: "text-destructive",
  success: "text-success",
  warning: "text-warning",
  inverse: "text-primary-foreground",
  none: "",
};

const SIZE: Record<Size, string> = {
  xs: "text-xs",
  sm: "text-[15px] leading-5",
  base: "text-base leading-6",
  lg: "text-lg leading-7",
  title: "text-2xl font-semibold tracking-tight",
  hero: "text-4xl font-bold tracking-tight",
};

/* Text with the app's type scale; color is always set so dark mode never
   falls back to React Native's default black. */
export function AppText({
  tone = "default",
  size = "base",
  weight,
  className,
  ...rest
}: TextProps & {
  tone?: Tone;
  size?: Size;
  weight?: "medium" | "semibold";
  className?: string;
}) {
  const w =
    weight === "medium"
      ? "font-medium"
      : weight === "semibold"
        ? "font-semibold"
        : "";
  return (
    <Text
      className={`${SIZE[size]} ${TONE[tone]} ${w} ${className ?? ""}`}
      {...rest}
    />
  );
}
