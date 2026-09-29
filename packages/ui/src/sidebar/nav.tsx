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
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13.5px] hover:bg-sidebar-accent [&_svg]:size-4 [&_svg]:text-primary"
    >
      {icon}
      {label}
      {count != null && (
        <span
          className={cn(
            "ml-auto min-w-5 rounded-full px-1.5 text-center font-semibold text-[11px]",
            tone === "amber"
              ? "bg-primary text-primary-foreground"
              : "bg-muted-foreground/15 text-muted-foreground",
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
    <div className="flex items-center px-4 pt-5 pb-1 font-semibold text-[11px] text-muted-foreground/80">
      {title}
      {onAdd && (
        <button
          onClick={onAdd}
          aria-label={`Add ${title}`}
          className="ml-auto text-foreground/70 hover:text-foreground"
        >
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
        "flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[13.5px] hover:bg-sidebar-accent",
        active &&
          "bg-primary/12 font-medium text-tint-text hover:bg-primary/15",
        c.unread && !active && "font-semibold",
      )}
    >
      <HashIcon
        className={cn(
          "size-3.5",
          active ? "text-tint-text" : "text-muted-foreground",
        )}
      />
      {c.name}
      {c.repo && (
        <FolderGit2Icon className="ml-auto size-3 text-muted-foreground" />
      )}
      {c.unread && !active ? (
        <span
          className={cn(
            "min-w-5 rounded-full bg-muted-foreground/15 px-1.5 text-center font-semibold text-[11px] text-muted-foreground",
            !c.repo && "ml-auto",
          )}
        >
          {c.unread}
        </span>
      ) : null}
    </button>
  );
}
