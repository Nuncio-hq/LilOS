import { CheckIcon, CopyIcon, SmartphoneIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Btn, Section, Spinner } from "./v3-bits";
import { Row, Switch, useFlash } from "./v3-settings-bits";
import type { V3PageProps, V3Settings } from "./v3-types";

/* Settings → Phone: the phones paired with this Mac, a one-time pairing card
   (a QR the phone scans, plus the same code to type), and which transitions
   buzz the phone. The prototype's QR is drawn, not encoded: squares from a
   seeded generator, so one code is always the same picture. */

const SIZE = 25;
// What the phone dials, as the pairing card shows it (the prototype's Mac).
const ADDRESS = "this-mac.tail4f2a.ts.net";

/** Small seeded generator (mulberry32): the same seed, the same squares. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One path of dark modules: seeded noise with the three finder squares. */
function qrPath(seed: number): string {
  const rnd = seeded(seed);
  let d = "";
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Keep the three 7x7 finders and their one-module quiet border clear.
      const inFinder =
        (x < 8 && y < 8) ||
        (x >= SIZE - 8 && y < 8) ||
        (x < 8 && y >= SIZE - 8);
      if (!inFinder && rnd() < 0.48) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  for (const [ox, oy] of [
    [0, 0],
    [SIZE - 7, 0],
    [0, SIZE - 7],
  ]) {
    // Ring, gap, centre: outer 7x7 minus inner 5x5, then a 3x3 block.
    d += `M${ox} ${oy}h7v7h-7zM${ox + 1} ${oy + 1}v5h5v-5z`;
    d += `M${ox + 2} ${oy + 2}h3v3h-3z`;
  }
  return d;
}

function Qr({ seed }: { seed: number }) {
  const path = useMemo(() => qrPath(seed), [seed]);
  return (
    // Always dark on white, whatever the theme: a phone camera needs contrast.
    <svg
      viewBox={`-2 -2 ${SIZE + 4} ${SIZE + 4}`}
      role="img"
      aria-label="Pairing code to scan with your iPhone"
      shapeRendering="crispEdges"
      className="size-[168px] rounded-lg bg-white"
    >
      <path d={path} fill="#1c1917" fillRule="evenodd" />
    </svg>
  );
}

type Offer = { seed: number; code: string; base: number };

/** The pairing card: QR, the code to type, and what to do on the phone. It
   shows "Paired" when the new device lands, then goes away on its own. */
function PairCard({
  offer,
  paired,
  onClose,
}: {
  offer: Offer;
  paired: boolean;
  onClose: () => void;
}) {
  const [copied, copy] = useFlash();
  const shown = `${offer.code.slice(0, 3)} ${offer.code.slice(3)}`;
  return (
    <div className="mt-4 rounded-lg border border-[var(--v3-line)] bg-[var(--v3-soft)] p-5">
      {paired ? (
        <div className="flex items-center gap-3 py-8">
          <span className="grid size-8 place-items-center rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-400/12 dark:text-emerald-300">
            <CheckIcon className="size-4" />
          </span>
          <div>
            <div className="font-medium text-[15px] text-foreground">
              Paired
            </div>
            <div className="text-[13px] text-muted-foreground">
              Notifications now reach it too.
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
          <Qr seed={offer.seed} />
          <div className="min-w-0 flex-1 basis-56">
            <p className="text-[14.5px] text-foreground">
              Open LilOS on your iPhone → Settings → Pair with Mac, then scan.
            </p>
            <div className="mt-4 text-[13px] text-muted-foreground">
              Can’t scan? Enter these on the phone:
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-[13px]">
              <span className="w-14 text-muted-foreground">Address</span>
              <span className="truncate font-mono text-foreground">
                {ADDRESS}
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-[13px]">
              <span className="w-14 text-muted-foreground">Code</span>
              <span className="font-mono text-[16px] text-foreground tracking-[0.12em]">
                {shown}
              </span>
              <Btn
                small
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(offer.code)
                    ?.catch(() => {});
                  copy();
                }}
              >
                <CopyIcon className="size-3.5" />
                {copied ? "Copied" : "Copy"}
              </Btn>
            </div>
            <div className="mt-5 flex items-center gap-3 text-[13px] text-muted-foreground">
              <Spinner />
              Waiting for the phone…
              <button
                type="button"
                onClick={onClose}
                className="ml-auto hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const PUSH: { key: keyof V3Settings["push"]; title: string; hint: string }[] = [
  {
    key: "needsYou",
    title: "Needs you",
    hint: "An agent asks a question or wants approval.",
  },
  {
    key: "stuck",
    title: "Stuck",
    hint: "An agent cannot get past something on its own.",
  },
  { key: "failed", title: "Failed", hint: "A run ended in an error." },
  { key: "finished", title: "Finished", hint: "A ticket is done and checked." },
];

export function PhonePane({ data, act }: V3PageProps) {
  const { devices, settings } = data;
  const [offer, setOffer] = useState<Offer>();
  const [confirm, setConfirm] = useState<string>();
  // The mock phone "scans" by adding a device; the card watches for it.
  const paired = !!offer && devices.length > offer.base;
  useEffect(() => {
    if (!paired) return;
    const t = window.setTimeout(() => setOffer(undefined), 2200);
    return () => window.clearTimeout(t);
  }, [paired]);

  const start = () => {
    const seed = Math.floor(Math.random() * 900000) + 100000;
    setOffer({ seed, code: String(seed), base: devices.length });
    act.pairPhone();
  };

  return (
    <>
      <Section title="Paired phones" count={devices.length} className="mt-6" />
      {devices.length === 0 && !offer && (
        <p className="border-[var(--v3-line)] border-b py-3 text-[14px] text-muted-foreground">
          No phone paired yet. Pair one to answer your agents from anywhere.
        </p>
      )}
      {devices.map((d) => (
        <div
          key={d.id}
          className="flex flex-wrap items-center gap-x-4 gap-y-2 border-[var(--v3-line)] border-b py-3"
        >
          <SmartphoneIcon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 basis-40">
            <div className="truncate text-[14.5px] text-foreground">
              {d.name}
            </div>
            <div className="truncate text-[13px] text-muted-foreground">
              {d.model} · last seen {d.lastSeen}
            </div>
          </div>
          {confirm === d.id ? (
            <span className="flex shrink-0 items-center gap-2 text-[13px]">
              <span className="text-muted-foreground">
                Unpair {d.name}? It stops reaching this Mac.
              </span>
              <Btn
                small
                onClick={() => {
                  act.unpairPhone(d.id);
                  setConfirm(undefined);
                }}
              >
                Unpair
              </Btn>
              <Btn small onClick={() => setConfirm(undefined)}>
                Keep
              </Btn>
            </span>
          ) : (
            <Btn small onClick={() => setConfirm(d.id)}>
              Unpair
            </Btn>
          )}
        </div>
      ))}
      <div className="mt-4">
        {!offer && (
          <Btn onClick={start}>
            <SmartphoneIcon className="size-3.5" />
            Pair a phone
          </Btn>
        )}
        {offer && (
          <PairCard
            offer={offer}
            paired={paired}
            onClose={() => setOffer(undefined)}
          />
        )}
      </div>

      <Section title="Notifications" />
      <p className="mb-1 text-[13px] text-muted-foreground">
        What your phone is told about. Quiet unless something needs you.
      </p>
      {PUSH.map((p) => (
        <Row key={p.key} title={p.title} hint={p.hint}>
          <Switch
            label={`${p.title} notifications`}
            on={settings.push[p.key]}
            onChange={(on) =>
              act.saveSettings({ push: { ...settings.push, [p.key]: on } })
            }
          />
        </Row>
      ))}
    </>
  );
}
