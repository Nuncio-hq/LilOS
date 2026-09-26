import { FolderGit2Icon, HashIcon, PlusIcon } from "lucide-react";
import { cn } from "../lib/utils";
import type { Channel } from "../types";

export function NavItem({
  icon,
  label,
  count,
  tone,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  tone?: "amber";
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent [&_svg]:size-4 [&_svg]:text-muted-foreground"
    >
      {icon}
      {label}
      {count != null && (
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 text-[11px] text-white",
            tone === "amber" ? "bg-amber-500" : "bg-blue-600",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export function Section({
  title,
  onAdd,
}: {
  title: string;
  onAdd?: () => void;
}) {
  return (
    <div className="flex items-center px-4 pt-4 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
      {title}
      {onAdd && (
        <button onClick={onAdd} className="ml-auto hover:text-foreground">
          <PlusIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function ChannelItem({
  c,
  active,
  onClick,
}: {
  c: Channel;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-sidebar-accent",
        active && "bg-sidebar-accent font-medium",
        c.unread && !active && "font-semibold",
      )}
    >
      <HashIcon className="size-3.5 text-muted-foreground" />
      {c.name}
      {c.repo && (
        <FolderGit2Icon className="ml-auto size-3 text-muted-foreground" />
      )}
      {c.unread && !active ? (
        <span
          className={cn(
            "rounded-full bg-blue-600 px-1.5 text-[11px] text-white",
            !c.repo && "ml-auto",
          )}
        >
          {c.unread}
        </span>
      ) : null}
    </button>
  );
}
