import { DeviceCache, MessageCache } from "@lilos/client-runtime";
import AsyncStorage from "@react-native-async-storage/async-storage";

const kv = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
  removeItem: (key: string) => AsyncStorage.removeItem(key),
};

/* The on-device Home snapshot (#154 AC-2): directory atoms + per-channel seq
   watermarks, in plain AsyncStorage — it's a cache, not a secret store (the
   credential is in the Keychain). Cold launch renders this while the socket
   is still opening; `afterSeq` replay then catches it up. */
export const directoryCache = new DeviceCache(kv);

/* #591 AC-3: per-conversation transcripts so a thread opened while the Mac
   is unreachable still shows what was last said, under the "Can't reach"
   line. Separate KV key so a bad record here never costs Home its
   directory. */
export const messageCache = new MessageCache(kv);
