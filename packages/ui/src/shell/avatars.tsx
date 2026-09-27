import hermesUrl from "../assets/hermes.svg";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { STATUS_DOT } from "../lib/helpers";
import { cn } from "../lib/utils";
import type { Human, Status } from "../types";

export function HermesAvatar({
  status,
  name,
  className,
}: {
  status?: Status;
  /* Employee name — its initial is the fallback when the mark can't load. */
  name?: string;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-block size-9 shrink-0", className)}>
      <Avatar className="size-full rounded-[28%] after:rounded-[28%]">
        <AvatarImage
          src={hermesUrl}
          alt={name ?? "Hermes"}
          className="rounded-[28%] dark:invert dark:hue-rotate-180"
        />
        <AvatarFallback className="rounded-[28%] bg-foreground/5 font-semibold text-muted-foreground">
          {(name ?? "H")[0]}
        </AvatarFallback>
      </Avatar>
      {status && (
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
            STATUS_DOT[status],
          )}
        />
      )}
    </span>
  );
}

export function HumanAvatar({ human }: { human: Human }) {
  return (
    <Avatar className="size-9 rounded-lg">
      <AvatarFallback
        className={cn("rounded-lg font-semibold text-white", human.color)}
      >
        {human.name[0]}
      </AvatarFallback>
    </Avatar>
  );
}
