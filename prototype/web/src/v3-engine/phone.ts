import type { V3DataActions } from "@lilos/ui"
import type { Engine } from "./context"

/* Settings → Phone: a one-time offer, the phone that scans it, unpairing, and
   closing the door the offer opened. */
export function phoneActions({ setData, toast }: Engine): Pick<
  V3DataActions,
  "pairPhone" | "unpairPhone" | "disablePhoneAccess"
> {
  // The phone that scans the current offer; one offer is live at a time.
  let scanning: number | undefined
  return {
    pairPhone: async () => {
      window.clearTimeout(scanning)
      // The prototype's phone scans the code two seconds later.
      scanning = window.setTimeout(() => {
        setData((d) => ({
          ...d,
          devices: [
            ...d.devices,
            {
              id: `d-${Date.now().toString(36)}`,
              name: "iPad",
              model: "iPad Air",
              lastSeen: "Just now",
            },
          ],
        }));
        toast("Paired · notifications go to this device too");
      }, 2000);
      const host = "this-mac.tail4f2a.ts.net";
      const code = Math.random().toString(36).slice(2, 14).toUpperCase().padEnd(12, "7");
      return {
        kind: "ready",
        offer: {
          host,
          code,
          url: `lilos://pair?host=${host}&name=This%20Mac#code=${code}`,
          expiresAt: Date.now() + 300_000,
        },
      };
    },
    unpairPhone: (deviceId) => {
      setData((d) => ({
        ...d,
        devices: d.devices.filter((x) => x.id !== deviceId),
      }));
      toast("Unpaired · it no longer reaches this Mac");
    },
    disablePhoneAccess: () => {
      // No phone reaches this Mac until the next offer, so one that was about
      // to scan this code no longer arrives. Paired phones stay listed: they
      // are removed with Unpair, never by closing the door.
      window.clearTimeout(scanning)
      scanning = undefined
      toast("Phone access is off · the next pairing turns it back on")
    },
  }
}
