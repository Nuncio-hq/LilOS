import { CheckIcon, CopyIcon, NetworkIcon, SmartphoneIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Btn, Section, Spinner } from "./v3-bits";
import { Row, Switch, useFlash } from "./v3-settings-bits";
import type {
  V3PageProps,
  V3Pairing,
  V3PairOffer,
  V3Settings,
} from "./v3-types";

/* Settings → Phone: the phones paired with this Mac, a one-time pairing card
   (a QR the phone scans, plus the same code to type) and, where the app
   sends pushes, which transitions buzz the phone. The offer is whatever the
   app minted; the card only draws it. */

/** Seconds until `at` (epoch ms), ticking; Infinity when there is no expiry. */
function useSecondsLeft(at: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === undefined) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [at]);
  return at === undefined
    ? Number.POSITIVE_INFINITY
    : Math.round((at - now) / 1000);
}

/** "7K4MQR2X9TBP" → "7K4M-QR2X-9TBP". */
const chunked = (code: string) => code.match(/.{1,4}/g)?.join("-") ?? code;

const clock = (s: number) =>
  `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function Facts({ offer, left }: { offer: V3PairOffer; left: number }) {
  const [copied, copy] = useFlash();
  const expired = left <= 0;
  return (
    <div className="min-w-0 flex-1 basis-56">
      <p className="text-[14.5px] text-foreground">
        Open LilOS on your iPhone → Settings → Pair with Mac, then scan.
      </p>
      <div
        className={cn(
          "mt-1 text-[13px]",
          expired ? "text-red-600 dark:text-red-300" : "text-muted-foreground",
        )}
      >
        {expired
          ? "This code expired. Make a new one."
          : Number.isFinite(left) && `Works once · expires in ${clock(left)}`}
      </div>
      <div className="mt-4 text-[13px] text-muted-foreground">
        Can’t scan? Enter these on the phone:
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[13px]">
        <span className="w-14 text-muted-foreground">Address</span>
        <span className="truncate font-mono text-foreground">{offer.host}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[13px]">
        <span className="w-14 text-muted-foreground">Code</span>
        <span className="font-mono text-[16px] text-foreground tracking-[0.12em]">
          {expired ? "———" : chunked(offer.code)}
        </span>
        {!expired && (
          <Btn
            small
            onClick={() => {
              void navigator.clipboard?.writeText(offer.code)?.catch(() => {});
              copy();
            }}
          >
            <CopyIcon className="size-3.5" />
            {copied ? "Copied" : "Copy"}
          </Btn>
        )}
      </div>
    </div>
  );
}

/** The pairing card: QR, the code to type, and what to do on the phone. It
   shows "Paired" when the new device lands, then goes away on its own. */
function PairCard({
  offer,
  paired,
  hasPush,
  onClose,
  onNewCode,
  onTurnOff,
}: {
  offer: V3PairOffer;
  paired: boolean;
  hasPush: boolean;
  onClose: () => void;
  onNewCode: () => void;
  onTurnOff?: () => void;
}) {
  const left = useSecondsLeft(offer.expiresAt);
  const expired = left <= 0;
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
              {hasPush
                ? "Notifications now reach it too."
                : "It connects to this Mac by itself from now on."}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
          {/* Always dark on white, whatever the theme: a phone camera needs
              contrast. */}
          <div className="relative rounded-lg bg-white p-2">
            <QRCodeSVG
              value={offer.url}
              size={152}
              level="M"
              role="img"
              aria-label="Pairing code to scan with your iPhone"
              className={cn(expired && "opacity-10 blur-[2px]")}
            />
            {expired && (
              <div className="absolute inset-0 grid place-items-center">
                <Btn small primary onClick={onNewCode}>
                  New code
                </Btn>
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1 basis-56">
            <Facts offer={offer} left={left} />
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
            {onTurnOff && (
              <button
                type="button"
                onClick={onTurnOff}
                className="mt-3 text-[12.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Turn off phone access
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The Mac is not reachable from a phone yet: what to turn on. */
function NoRemote({ onClose }: { onClose: () => void }) {
  return (
    <div className="mt-4 rounded-lg border border-[var(--v3-line)] bg-[var(--v3-soft)] p-5">
      <div className="flex items-center gap-2 font-medium text-[15px] text-foreground">
        <NetworkIcon className="size-4 text-amber-600 dark:text-amber-300" />
        Turn on Tailscale first
      </div>
      <p className="mt-1.5 text-[13.5px] text-muted-foreground">
        Your phone reaches this Mac through Tailscale, so it works at home and
        away. Tailscale isn’t running on this Mac yet.
      </p>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-[13.5px] text-muted-foreground">
        <li>Install Tailscale on this Mac and sign in.</li>
        <li>Install it on your iPhone with the same account.</li>
        <li>Come back here and press Pair a phone again.</li>
      </ol>
      <button
        type="button"
        onClick={onClose}
        className="mt-4 text-[13px] text-muted-foreground hover:text-foreground"
      >
        Close
      </button>
    </div>
  );
}

const PUSH: {
  key: keyof NonNullable<V3Settings["push"]>;
  title: string;
  hint: string;
}[] = [
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
  const { push } = settings;
  const [pairing, setPairing] = useState<V3Pairing | "busy">();
  const [confirm, setConfirm] = useState<string>();
  // The devices there were when the offer was made: the phone has arrived
  // when one that is not among them shows up.
  const baseline = useRef(new Set<string>());
  const paired =
    typeof pairing === "object" &&
    pairing.kind === "ready" &&
    devices.some((d) => !baseline.current.has(d.id));
  /* An offer is spent once its phone has arrived. Unpairing that very phone
     while "Paired" shows flips `paired` back to false, which would un-hide the
     dead code: `spent` remembers it (set in render, so no frame draws the
     code) and the effect then clears the offer, leaving the empty state. */
  const [spent, setSpent] = useState(false);
  if (paired && !spent) setSpent(true);
  useEffect(() => {
    if (!paired) {
      if (spent) {
        setSpent(false);
        setPairing(undefined);
      }
      return;
    }
    const t = window.setTimeout(() => setPairing(undefined), 2200);
    return () => window.clearTimeout(t);
  }, [paired, spent]);

  const start = () => {
    baseline.current = new Set(devices.map((d) => d.id));
    setSpent(false);
    setPairing("busy");
    // A rejection means the app has already said why; the card just goes.
    act.pairPhone().then(setPairing, () => setPairing(undefined));
  };

  return (
    <>
      <Section title="Paired phones" count={devices.length} className="mt-6" />
      {devices.length === 0 && !pairing && (
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
              {[d.model, `last seen ${d.lastSeen}`].filter(Boolean).join(" · ")}
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
        {!pairing && (
          <Btn onClick={start}>
            <SmartphoneIcon className="size-3.5" />
            Pair a phone
          </Btn>
        )}
        {pairing === "busy" && (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Spinner />
            Making a code…
          </div>
        )}
        {typeof pairing === "object" && pairing.kind === "no-remote" && (
          <NoRemote onClose={() => setPairing(undefined)} />
        )}
        {typeof pairing === "object" &&
          pairing.kind === "ready" &&
          (paired || !spent) && (
            <PairCard
              offer={pairing.offer}
              paired={paired}
              hasPush={!!push}
              onClose={() => setPairing(undefined)}
              onNewCode={start}
              onTurnOff={
                act.disablePhoneAccess
                  ? () => {
                      act.disablePhoneAccess?.();
                      setPairing(undefined);
                    }
                  : undefined
              }
            />
          )}
      </div>

      {push && (
        <>
          <Section title="Notifications" />
          <p className="mb-1 text-[13px] text-muted-foreground">
            What your phone is told about. Quiet unless something needs you.
          </p>
          {PUSH.map((p) => (
            <Row key={p.key} title={p.title} hint={p.hint}>
              <Switch
                label={`${p.title} notifications`}
                on={push[p.key]}
                onChange={(on) =>
                  act.saveSettings({ push: { ...push, [p.key]: on } })
                }
              />
            </Row>
          ))}
        </>
      )}
    </>
  );
}
