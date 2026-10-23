import "../global.css";

import { useStore } from "@nanostores/react";
import * as Linking from "expo-linking";
import { atom } from "nanostores";
import { useEffect } from "react";
import App from "./App";
import { applyPreview, previewQuery } from "./v3/deep-links";
import { V3App } from "./v3/v3-app";

/* v3 is the app. The v2 prototype stays one deep link away
   (`lilos://preview?ui=v2`, back with `?ui=v3`) so both can be compared on
   the same simulator. */
const $ui = atom<"v2" | "v3">("v3");

/* One listener for every preview link, per opened link (the latest-URL hook
   would miss the same link opened twice). The ui switch comes first, then
   the rest of the query goes to v3's handler, which waits for its screens
   to exist: `?ui=v3&open=work` from v2 lands on Work once v3 has mounted.
   While v2 is showing, v2's own handler reads the link. */
function usePreviewLinks() {
  useEffect(() => {
    const handle = (url: string | null) => {
      const query = previewQuery(url);
      if (query === undefined) return;
      const ui = new URLSearchParams(query).get("ui");
      if (ui === "v2" || ui === "v3") $ui.set(ui);
      if ($ui.get() === "v3") applyPreview(query);
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", (e) => handle(e.url));
    return () => sub.remove();
  }, []);
}

export default function Root() {
  const ui = useStore($ui);
  usePreviewLinks();
  return ui === "v2" ? <App /> : <V3App />;
}
