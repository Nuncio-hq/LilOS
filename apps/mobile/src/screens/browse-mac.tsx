import type {
  FoldersBrowseResult,
  FoldersDiscoverResult,
} from "@lilos/contracts/app";
import { type MacDir, MacFolderBrowser } from "@lilos/ui-native";
import { useStore } from "@nanostores/react";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useState } from "react";
import { Alert } from "react-native";
import { browseWorkspacePick } from "../dm-model";
import { $wsPicks, addRecentFolder } from "../dm-store";
import { $client } from "../link";
import { describeError } from "../mapping";
import { $connections } from "../paired-macs";
import type { DmRoutes } from "../routes";

/* "Other folder on the Mac…" (#238): the shared MacFolderBrowser driven by
   the real `folders.browse`/`folders.discover` calls — the harness keeps
   the listing under the Mac's home. A null readDir is the sheet's
   "Can't reach the Mac right now." state (AC-5). Use → `folders.add`, a
   recents + probes resync, the composer pick, then both sheets close back
   to the DM (prototype BrowseMac). */

export function BrowseMac({
  navigation,
  route,
}: {
  navigation: NativeStackNavigationProp<DmRoutes>;
  route: RouteProp<DmRoutes, "BrowseMac">;
}) {
  const { employeeId } = route.params;
  const client = useStore($client);
  const mac = useStore($connections)[0];
  const [found, setFound] = useState<{ path: string; branch?: string }[]>([]);

  /* "Found on this Mac" (AC-2): same `git.discoverRepos` roots the web
     scans — loaded once when the sheet opens; a failure just hides the
     group. */
  useEffect(() => {
    if (!client) return;
    let live = true;
    void client
      .request<FoldersDiscoverResult>("folders.discover", {})
      .then((r) => {
        if (live) setFound(r.repos);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client]);

  const readDir = useCallback(
    async (path: string): Promise<MacDir | null> => {
      if (!client) return null;
      try {
        const r = await client.request<FoldersBrowseResult>("folders.browse", {
          path,
        });
        return {
          ...(r.branch ? { branch: r.branch } : {}),
          folders: r.folders,
        };
      } catch {
        return null;
      }
    },
    [client],
  );

  const use = (path: string, dir: MacDir) => {
    const c = client;
    if (!c) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    void (async () => {
      try {
        await addRecentFolder(c, path);
      } catch (e) {
        Alert.alert("Couldn't use this folder", describeError(e));
        return;
      }
      $wsPicks.set({
        ...$wsPicks.get(),
        [employeeId]: browseWorkspacePick(path, dir),
      });
      navigation.pop(2);
    })();
  };

  return (
    <MacFolderBrowser
      macName={mac?.name ?? "Mac"}
      found={found}
      readDir={readDir}
      onUse={use}
      onDone={() => navigation.goBack()}
    />
  );
}
