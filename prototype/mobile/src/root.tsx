import "../global.css";

import { useStore } from "@nanostores/react";
import * as Linking from "expo-linking";
import { atom } from "nanostores";
import { useEffect } from "react";
import App from "./App";
import { V3App } from "./v3/v3-app";

/* v3 is the app. The v2 prototype stays one deep link away
   (`lilos://preview?ui=v2`, back with `?ui=v3`) so both can be compared on
   the same simulator. */
const $ui = atom<"v2" | "v3">("v3");

function useUiSwitch() {
  useEffect(() => {
    const handle = (url: string | null) => {
      const m = url ? /^lilos:\/\/preview\/?\?(.*)$/i.exec(url) : null;
      const ui = m ? new URLSearchParams(m[1]).get("ui") : null;
      if (ui === "v2" || ui === "v3") $ui.set(ui);
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", (e) => handle(e.url));
    return () => sub.remove();
  }, []);
}

export default function Root() {
  const ui = useStore($ui);
  useUiSwitch();
  return ui === "v2" ? <App /> : <V3App />;
}
