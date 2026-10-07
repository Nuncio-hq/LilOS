import { registerRootComponent } from "expo";
import { LogBox } from "react-native";

import App from "./src/App";

/* CHAT_HEADER stacks blurEffect with a bottom-only scrollEdgeEffect on
   purpose (see src/App.tsx — the bar needs the full material). Newer
   RNScreens warns about the combination anyway; it's the intended look,
   so the dev LogBox nag is silenced here rather than removed. */
LogBox.ignoreLogs([
  "Using both `blurEffect` and `scrollEdgeEffects` simultaneously may cause overlapping effects",
]);

registerRootComponent(App);
