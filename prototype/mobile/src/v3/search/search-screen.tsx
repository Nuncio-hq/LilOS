import type { V3Data } from "@lilos/ui/v3-data";
import { useThemeColor } from "@lilos/ui-native";
import { type RecentUpdateVM, SearchResults } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import type { NativeBottomTabNavigationProp } from "@react-navigation/bottom-tabs/unstable";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SearchBarCommands } from "react-native-screens";
import { hapticSelect } from "../haptics";
import { CEO_THREAD_ID, personOf } from "../model";
import { openAgent, openThread, openTicket, type TabRoutes } from "../nav";
import { $data, askCeo, markSeen } from "../store";
import { searchCompany } from "./match";

/* The search-role tab. iOS 26 shows its native search field in a glass
   capsule next to the tab bar; what is typed drives the results below. */

/** The CEO's latest updates shown while nothing is typed. */
const RECENT_LIMIT = 6;

function recentUpdates(d: V3Data): RecentUpdateVM[] {
  return d.updates.slice(0, RECENT_LIMIT).map((u) => {
    // A system note is LilOS, not an agent: no avatar, no person page.
    const system = u.authorKind === "system";
    const who = system ? undefined : personOf(d, u.by);
    return {
      id: u.id,
      who,
      whoName: who?.name ?? "LilOS",
      at: u.at,
      text: u.text,
      ticketTag: u.ticketId,
    };
  });
}

export function AskCeoContainer() {
  const data = useStore($data);
  const navigation =
    useNavigation<NativeBottomTabNavigationProp<TabRoutes, "AskCeo">>();
  const ink = useThemeColor("ink");
  const [typed, setTyped] = useState("");
  const field = useRef<SearchBarCommands>(null);
  const query = typed.trim();

  // The same path for the "Ask the CEO" row and the keyboard's search key.
  const ask = useCallback((text: string) => {
    const question = text.trim();
    if (!question) return;
    hapticSelect();
    askCeo(question);
    setTyped("");
    field.current?.clearText();
    openThread(CEO_THREAD_ID);
  }, []);

  useEffect(() => {
    navigation.setOptions({
      // A serif large title like the other tabs' in-content titles.
      headerLargeTitleEnabled: true,
      headerLargeTitleStyle: { fontFamily: "Charter" },
      headerSearchBarOptions: {
        ref: field,
        placeholder: "Ask the CEO or search",
        // `automatic` lets a search-system-item tab move the field into the
        // glass capsule beside the tab bar on iOS 26; the other placements
        // are for fields that sit in a navigation bar instead.
        placement: "automatic",
        allowToolbarIntegration: true,
        // A question reads as a sentence; matching ignores case anyway.
        autoCapitalize: "sentences",
        // The results are the content, so the field must not dim them or
        // slide away while the list scrolls.
        obscureBackground: false,
        hideWhenScrolling: false,
        tintColor: ink,
        onChangeText: (e) => setTyped(e.nativeEvent.text),
        onSearchButtonPress: (e) => ask(e.nativeEvent.text),
        // Cancel closes the field; start from the empty page next time.
        onCancelButtonPress: () => setTyped(""),
      },
    });
  }, [navigation, ask, ink]);

  const hits = useMemo(() => searchCompany(data, query), [data, query]);
  const recent = useMemo(() => recentUpdates(data), [data]);
  const ceo = useMemo(
    () => (data.ceoId ? personOf(data, data.ceoId) : undefined),
    [data],
  );

  return (
    <SearchResults
      query={query}
      ceo={ceo}
      recent={recent}
      people={hits.people}
      threads={hits.threads}
      tickets={hits.tickets}
      onAsk={() => ask(query)}
      onOpenCeoThread={() => openThread(CEO_THREAD_ID)}
      onOpenPerson={openAgent}
      onOpenThread={(id) => {
        hapticSelect();
        markSeen(id);
        openThread(id);
      }}
      onOpenTicket={openTicket}
    />
  );
}
