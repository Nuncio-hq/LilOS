import {
  CheckCircle2Icon,
  CopyIcon,
  NetworkIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";

/* Pair phone (Mac side of mobile onboarding). Shows a one-time QR the iPhone
   scans, with the address + code underneath for typing by hand. States:
   - `ready`: QR + code, counting down to expiry → then `expired` (New code).
   - `no-remote`: the Mac isn't reachable from the phone (Tailscale off), so
     no code is offered; says what to turn on.
   - `paired`: a phone just used the code.
   Props in, callbacks out: the offer/code are the relay's real one-time
   grants (#153), minted by `pairing.offer`; the device list comes from
   `devices.changed`/`devices.list`. */

export type PairPhoneOffer = {
  host: string;
  /** Raw one-time grant (12 chars) — shown chunked as 4-4-4. */
  code: string;
  name: string;
  /** epoch ms */
  expiresAt: number;
};

/** A phone already paired to this Mac (#153) — shown with its Remove. */
export type PairPhoneDevice = {
  id: string;
  name: string;
  /** epoch ms */
  pairedAt: number;
  /** epoch ms */
  lastSeenAt: number;
};

export type PairPhoneState =
  | { kind: "ready"; offer: PairPhoneOffer }
  | { kind: "no-remote" }
  | { kind: "paired"; device: string; macName: string };

export function pairingUrl(o: PairPhoneOffer): string {
  const q = new URLSearchParams({ host: o.host, name: o.name });
  // The grant is the secret — it rides the URL fragment, never the query
  // (#153: `lilos://pair?host=…#code=…`).
  return `lilos://pair?${q.toString()}#code=${o.code}`;
}

/** "7K4MQR2X9TBP" → "7K4M-QR2X-9TBP". */
function formatGrantCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

export function PairPhoneDialog({
  state,
  onNewCode,
  onClose,
  onCopied,
  devices,
  onRevokeDevice,
  onTurnOff,
}: {
  state: PairPhoneState;
  onNewCode: () => void;
  onClose: () => void;
  onCopied?: (what: string) => void;
  /** Paired phones (#153); rendered with a Remove button under the offer. */
  devices?: PairPhoneDevice[];
  onRevokeDevice?: (id: string) => void;
  /** "Turn off phone access" — the way out of the opt-in Tailscale bind. */
  onTurnOff?: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-pairphone={state.kind}
      >
        <div className="flex items-center gap-2 border-b px-5 py-3">
          <SmartphoneIcon className="size-4" />
          <div className="font-semibold">Pair phone</div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon />
          </Button>
        </div>
        {state.kind === "ready" && (
          <Ready
            offer={state.offer}
            onNewCode={onNewCode}
            onCopied={onCopied}
            onTurnOff={onTurnOff}
          />
        )}
        {state.kind === "no-remote" && <NoRemote />}
        {state.kind === "paired" && (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <CheckCircle2Icon className="size-10 text-emerald-600" />
            <div className="font-semibold text-base">
              {state.device} is paired
            </div>
            <p className="text-muted-foreground">
              It connects to {state.macName} by itself from now on. You can
              close this.
            </p>
            <Button className="mt-2" onClick={onClose}>
              Done
            </Button>
          </div>
        )}
        {devices !== undefined && devices.length > 0 && (
          <DeviceList devices={devices} onRevoke={onRevokeDevice} />
        )}
      </div>
    </div>
  );
}

/** Paired phones — name, paired/last-seen, and the Revoke (AC-4). */
function DeviceList({
  devices,
  onRevoke,
}: {
  devices: PairPhoneDevice[];
  onRevoke?: (id: string) => void;
}) {
  return (
    <div className="border-t px-5 py-4" data-pairphone-devices>
      <div className="pb-2 text-muted-foreground text-xs">Paired phones</div>
      <ul className="space-y-2">
        {devices.map((d) => (
          <li
            key={d.id}
            className="flex items-center gap-3 text-[13px]"
            data-pairphone-device={d.id}
          >
            <SmartphoneIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{d.name}</div>
              <div className="text-muted-foreground text-xs">
                Paired {fmtWhen(d.pairedAt)} · last seen {fmtWhen(d.lastSeenAt)}
              </div>
            </div>
            {onRevoke && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onRevoke(d.id)}
                aria-label={`Remove ${d.name}`}
                data-pairphone-revoke={d.id}
              >
                <Trash2Icon />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function fmtWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Ready({
  offer,
  onNewCode,
  onCopied,
  onTurnOff,
}: {
  offer: PairPhoneOffer;
  onNewCode: () => void;
  onCopied?: (what: string) => void;
  onTurnOff?: () => void;
}) {
  const left = useSecondsLeft(offer.expiresAt);
  const expired = left <= 0;
  const code = formatGrantCode(offer.code);
  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text);
    onCopied?.(what);
  };
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-6">
      <p className="text-center text-muted-foreground">
        Open LilOS on your iPhone and scan this code.
      </p>
      <div className="relative rounded-2xl border bg-white p-4" data-pairqr>
        <QRCodeSVG
          value={pairingUrl(offer)}
          size={200}
          level="M"
          className={cn(expired && "opacity-10 blur-[2px]")}
        />
        {expired && (
          <div className="absolute inset-0 grid place-items-center">
            <Button size="sm" onClick={onNewCode} data-newcode>
              <RefreshCwIcon /> New code
            </Button>
          </div>
        )}
      </div>
      <div
        className={cn(
          "text-xs",
          expired ? "text-destructive" : "text-muted-foreground",
        )}
        data-expiry
      >
        {expired
          ? "This code expired. Make a new one."
          : `Works once · expires in ${fmt(left)}`}
      </div>
      <div className="w-full space-y-1.5 rounded-lg bg-muted/50 p-3 text-[13px]">
        <div className="text-muted-foreground text-xs">
          Can't scan? Enter these on the phone:
        </div>
        <CopyRow
          label="Address"
          value={offer.host}
          onCopy={() => copy(offer.host, "Address copied")}
        />
        <CopyRow
          label="Code"
          value={expired ? "———" : code}
          mono
          onCopy={expired ? undefined : () => copy(offer.code, "Code copied")}
        />
      </div>
      <div className="flex w-full items-start gap-2 text-muted-foreground text-xs">
        <NetworkIcon className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Reachable over Tailscale, so the phone works away from home too — as
          long as Tailscale is on there with the same account.
        </span>
      </div>
      {onTurnOff && (
        <button
          type="button"
          className="text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
          onClick={onTurnOff}
          data-pairphone-disable
        >
          Turn off phone access
        </button>
      )}
    </div>
  );
}

function NoRemote() {
  return (
    <div className="flex flex-col gap-3 px-6 py-6" data-pair-noremote>
      <NetworkIcon className="size-8 text-amber-600" />
      <div className="font-semibold text-base">Turn on Tailscale first</div>
      <p className="text-muted-foreground">
        Your phone reaches this Mac through Tailscale, so it works at home and
        away. Tailscale isn't running on this Mac yet.
      </p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>Install Tailscale on this Mac and sign in.</li>
        <li>Install it on your iPhone with the same account.</li>
        <li>Come back here — the code appears by itself.</li>
      </ol>
    </div>
  );
}

function CopyRow({
  label,
  value,
  mono,
  onCopy,
}: {
  label: string;
  value: string;
  mono?: boolean;
  onCopy?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          mono ? "font-mono text-base tracking-widest" : "font-mono text-xs",
        )}
        data-pair-value={label}
      >
        {value}
      </span>
      {onCopy && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onCopy}
          aria-label={`Copy ${label}`}
        >
          <CopyIcon />
        </Button>
      )}
    </div>
  );
}

function useSecondsLeft(until: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.ceil((until - now) / 1000));
}

function fmt(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
