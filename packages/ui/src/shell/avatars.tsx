import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { STATUS_DOT } from "../lib/helpers";
import { cn } from "../lib/utils";
import type { Human, Status } from "../types";

/* An employee's identity: the same soft color orb as the mobile app
   (packages/ui-native/src/components/orb.tsx) — radial blobs over a base
   under a glassy highlight. The tone comes from the name so every surface
   agrees without passing it around (Builder blue, Reviewer violet, Marketer
   sunset, Default stone — the mobile prototype's picks). */
const TONES = {
  blue: ["#3f7ff5", "#4fe3d2", "#7b6cff"],
  violet: ["#9a5cf0", "#ff6fa8", "#ffb14a"],
  sunset: ["#f47a3a", "#ffd84d", "#ff5a5f"],
  mint: ["#2fae8e", "#b6f09a", "#1f7fa8"],
  rose: ["#e8577a", "#ffc0a8", "#b04ad0"],
  stone: ["#a79f92", "#cfc6b4", "#8c8478"],
} as const;
type Tone = keyof typeof TONES;
const ORDER = Object.keys(TONES) as Tone[];

/** Name → tone: 31-polynomial hash + murmur3 finalizer; salt 124 lands the seeded names on mobile's tones. */
export function orbTone(name = ""): Tone {
  let x = 124;
  for (const ch of name.toLowerCase())
    x = (Math.imul(x, 31) + ch.charCodeAt(0)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return ORDER[(x >>> 0) % ORDER.length];
}

export function HermesAvatar({
  status,
  name,
  className,
}: {
  status?: Status;
  /* Employee name — picks the orb's tone and labels it. */
  name?: string;
  className?: string;
}) {
  const [base, a, b] = TONES[orbTone(name)];
  return (
    <span
      role="img"
      aria-label={name ?? "Employee"}
      className={cn("relative inline-block size-9 shrink-0", className)}
    >
      <span
        className="block size-full rounded-full ring-1 ring-white/35 ring-inset"
        style={{
          backgroundColor: base,
          backgroundImage: `radial-gradient(circle farthest-side at 30% 8%, rgba(255,255,255,.42), rgba(255,255,255,0) 55%), radial-gradient(circle closest-side at 72% 78%, ${a}, ${a}00), radial-gradient(circle farthest-side at 25% 72%, ${b}, ${b}00 70%)`,
        }}
      />
      {status && (
        <span
          data-presence={status}
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
            STATUS_DOT[status],
          )}
        />
      )}
    </span>
  );
}

/* The person's avatar everywhere a human appears — message rows, the sidebar
   footer (`size="sm"`). One identity: image when the Human carries one, else
   a high-contrast initial on the human's colour (white on bg-*-600 ≥ AA).
   `className` overrides the shape (rounded-lg rows / rounded-full footer). */
export function HumanAvatar({
  human,
  className,
  size,
}: {
  human: Human;
  className?: string;
  size?: "sm" | "lg";
}) {
  return (
    <Avatar
      size={size}
      className={cn("rounded-full", size === undefined && "size-9", className)}
    >
      {human.image && (
        <AvatarImage
          src={human.image}
          alt={human.name}
          className="rounded-[inherit]"
        />
      )}
      <AvatarFallback
        className={cn(
          "rounded-[inherit] font-semibold text-white",
          human.color,
        )}
      >
        {human.name[0]}
      </AvatarFallback>
    </Avatar>
  );
}
