import {
  CheckCircle2Icon,
  CopyIcon,
  NetworkIcon,
  RefreshCwIcon,
  SmartphoneIcon,
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
   The pairing grant itself is backend work; this is props in, callbacks out. */

export type PairPhoneOffer = {
  host: string;
  code: string;
  name: string;
  /** epoch ms */
  expiresAt: number;
};

export type PairPhoneState =
  | { kind: "ready"; offer: PairPhoneOffer }
  | { kind: "no-remote" }
  | { kind: "paired"; device: string; macName: string };

export function pairingUrl(o: PairPhoneOffer): string {
  const q = new URLSearchParams({ host: o.host, code: o.code, name: o.name });
  return `lilos://pair?${q.toString()}`;
}

export function PairPhoneDialog({
  state,
  onNewCode,
  onClose,
  onCopied,
}: {
  state: PairPhoneState;
  onNewCode: () => void;
  onClose: () => void;
  onCopied?: (what: string) => void;
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
      </div>
    </div>
  );
}

function Ready({
  offer,
  onNewCode,
  onCopied,
}: {
  offer: PairPhoneOffer;
  onNewCode: () => void;
  onCopied?: (what: string) => void;
}) {
  const left = useSecondsLeft(offer.expiresAt);
  const expired = left <= 0;
  const code = `${offer.code.slice(0, 3)}-${offer.code.slice(3)}`;
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
