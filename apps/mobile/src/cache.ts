import { DeviceCache } from "@lilos/client-runtime";
import AsyncStorage from "@react-native-async-storage/async-storage";

/* The on-device Home snapshot (#154 AC-2): directory atoms + per-channel seq
   watermarks, in plain AsyncStorage — it's a cache, not a secret store (the
   credential is in the Keychain). Cold launch renders this while the socket
   is still opening; `afterSeq` replay then catches it up. */
export const directoryCache = new DeviceCache({
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
});
