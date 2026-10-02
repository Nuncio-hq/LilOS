import { registerRootComponent } from "expo";

import App from "./src/App";
import { installNetSpy } from "./src/netspy";

/* #168 evidence: dev builds count every JS-level network call so the
   offline demo run can show a live zero. Installed before App so even
   boot-time traffic is caught; production never calls this. */
if (__DEV__) installNetSpy();

/* #264: React Native's dev "Refreshing…" toast is a separate UIWindow pinned
   above the status bar — it covers the nav header and can never push content
   down, so dev builds suppress just that toast. Error toasts (e.g. "Fast
   Refresh disconnected") and the native bundle-download bar still show. */
if (__DEV__) {
  const DevLoadingView =
    require("react-native/Libraries/Utilities/DevLoadingView").default;
  const showMessage = DevLoadingView.showMessage;
  DevLoadingView.showMessage = (
    message: string,
    type: string,
    options?: unknown,
  ) => (type === "refresh" ? undefined : showMessage(message, type, options));
}

registerRootComponent(App);
