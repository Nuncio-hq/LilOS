import { useThemeColor } from "@lilos/ui-native";
import { DarkTheme, DefaultTheme, type Theme } from "@react-navigation/native";
import { useColorScheme } from "react-native";

/* The navigation chrome on the v3 paper: header and tab backgrounds are the
   paper, text is ink, so a pushed screen never flashes a v2 colour. */
export function useV3NavTheme(): Theme {
  const dark = useColorScheme() === "dark";
  const base = dark ? DarkTheme : DefaultTheme;
  const paper = useThemeColor("paper") ?? base.colors.background;
  const ink = useThemeColor("ink") ?? base.colors.text;
  const rule = useThemeColor("rule") ?? base.colors.border;
  return {
    ...base,
    colors: {
      ...base.colors,
      background: paper,
      card: paper,
      text: ink,
      border: rule,
      primary: ink,
    },
  };
}
