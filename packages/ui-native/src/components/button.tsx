import type { SFSymbol } from "expo-symbols";
import { ActivityIndicator, Pressable, View } from "react-native";
import { AppText } from "./app-text";
import { Icon, type IconTone, useThemeColor } from "./icon";

type Variant = "primary" | "secondary" | "ghost" | "destructive";

const BOX: Record<Variant, string> = {
  primary: "bg-primary",
  secondary: "bg-secondary",
  ghost: "bg-transparent",
  destructive: "bg-secondary",
};

const LABEL: Record<Variant, "inverse" | "default" | "destructive"> = {
  primary: "inverse",
  secondary: "default",
  ghost: "default",
  destructive: "destructive",
};

const ICON: Record<Variant, IconTone> = {
  primary: "primary-foreground",
  secondary: "foreground",
  ghost: "foreground",
  destructive: "destructive",
};

/* Full-width, 52pt tall — the iOS onboarding button size (thumb reach). */
export function Button({
  label,
  onPress,
  variant = "primary",
  icon,
  busy,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  icon?: SFSymbol;
  busy?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  const spinner = useThemeColor(
    variant === "primary" ? "primary-foreground" : "foreground",
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      onPress={onPress}
      disabled={disabled || busy}
      className={`h-[52px] flex-row items-center justify-center gap-2 rounded-2xl px-5 active:opacity-70 ${BOX[variant]} ${disabled ? "opacity-40" : ""}`}
    >
      {busy ? (
        <ActivityIndicator color={spinner} />
      ) : (
        <View className="flex-row items-center gap-2">
          {icon && (
            <Icon name={icon} size={18} tone={ICON[variant]} weight="medium" />
          )}
          <AppText tone={LABEL[variant]} weight="semibold" size="base">
            {label}
          </AppText>
        </View>
      )}
    </Pressable>
  );
}
