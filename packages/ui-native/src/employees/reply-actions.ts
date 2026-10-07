import * as Clipboard from "expo-clipboard";
import { Alert, Share } from "react-native";

/* #556 AC-1: a long-press on an agent reply offers its raw markdown as
   Copy or Share — the choice sheet is Alert-based like every other
   confirm in the app. */
export function replyActionsSheet(markdown: string): void {
  Alert.alert("Reply", undefined, [
    { text: "Copy", onPress: () => void Clipboard.setStringAsync(markdown) },
    {
      text: "Share…",
      onPress: () => void Share.share({ message: markdown }).catch(() => {}),
    },
    { text: "Cancel", style: "cancel" },
  ]);
}
