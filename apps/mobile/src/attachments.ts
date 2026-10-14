import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@lilos/contracts/app";
import type { AttachmentChip } from "@lilos/ui-native";
import * as DocumentPicker from "expo-document-picker";
/* SDK 57's main entry is the File/Directory API; the read helper the
   picker needs (uri → base64) stays under /legacy. */
import { readAsStringAsync } from "expo-file-system/legacy";
import { Alert } from "react-native";

/** A staged composer file: the chip fields plus the wire-ready bytes. */
export type PickedFile = AttachmentChip & { dataBase64: string };

/* The relay validates and stores attachments from bytes, so the phone
   reads them itself — a URL would leave nothing to send. */
export async function pickFiles(current: number): Promise<PickedFile[]> {
  const room = MAX_ATTACHMENTS_PER_MESSAGE - current;
  if (room <= 0) {
    Alert.alert(
      "That's enough files",
      `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`,
    );
    return [];
  }
  const res = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (res.canceled) return [];
  const picked: PickedFile[] = [];
  const skippedOver = room - res.assets.length;
  for (const asset of res.assets.slice(0, room)) {
    const size = asset.size ?? 0;
    if (size > MAX_ATTACHMENT_BYTES) {
      Alert.alert(
        "That file is too large to attach (10 MB max per file).",
        asset.name,
      );
      continue;
    }
    const dataBase64 = await readAsStringAsync(asset.uri, {
      encoding: "base64",
    });
    picked.push({
      name: asset.name || "attachment",
      sizeBytes: size,
      /* An unknown type still has to reach the wire — the contract's
         mimeType is min(1) so octet-stream stands in. */
      mimeType: asset.mimeType || "application/octet-stream",
      dataBase64,
    });
  }
  if (skippedOver < 0) {
    Alert.alert(
      "Some files were left out",
      `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`,
    );
  }
  return picked;
}
