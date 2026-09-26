import { Avatar, AvatarFallback } from "../components/ui/avatar";
import { STATUS_DOT } from "../lib/helpers";
import { cn } from "../lib/utils";
import type { Human, Status } from "../types";

export function HermesAvatar({
  status,
  className,
}: {
  status?: Status;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-block size-9 shrink-0", className)}>
      <img
        src="/hermes.svg"
        alt="Hermes"
        className="size-full rounded-[28%] dark:invert dark:hue-rotate-180"
      />
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
