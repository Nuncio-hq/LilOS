/* @lilos/ui-native — LilOS mobile UI (React Native). Same rule as @lilos/ui:
   props in, callbacks out; no navigation, stores or native modules beyond
   rendering. Apps (prototype/mobile now, apps/mobile later) wire them. */

export { HomeScreen } from "./app/home-screen";
export { type MacLink, MacStatusCard } from "./app/mac-status-card";
export { SettingsScreen } from "./app/settings-screen";
export { AppText } from "./components/app-text";
export { Button } from "./components/button";
export { Choice, Row, Section } from "./components/grouped-list";
export { Icon, type IconTone, useThemeColor } from "./components/icon";
export { Screen } from "./components/screen";
export { Mono, StateBlock } from "./components/state-block";
export {
  buildPairingUrl,
  CODE_LENGTH,
  formatCode,
  normalizeCode,
  normalizeHost,
  type PairingOffer,
  parsePairingUrl,
} from "./lib/pairing-code";
export { ConnectedScreen } from "./onboarding/connected-screen";
export {
  ConnectingScreen,
  type ConnectingState,
} from "./onboarding/connecting-screen";
export { MacCard } from "./onboarding/mac-card";
export { ManualCodeScreen } from "./onboarding/manual-code-screen";
export { PairIntroScreen } from "./onboarding/pair-intro-screen";
export { ScanScreen } from "./onboarding/scan-screen";
export { WelcomeScreen } from "./onboarding/welcome-screen";
