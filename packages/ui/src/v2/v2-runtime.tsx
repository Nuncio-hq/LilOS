import hermesLogo from "../assets/hermes.svg";
import { cn } from "../lib/utils";
import { CLAUDE_MARK } from "./runtime-marks";

/** An agent runtime LilOS can run an agent on: Hermes now; later ones only
    through ACP (#111). Outside bots are connectors, never runtimes (#746). */
export type V2Runtime = "hermes" | "claude-code";

export const RUNTIME_NAME: Record<V2Runtime, string> = {
  hermes: "Hermes",
  "claude-code": "Claude Code",
};

const MARK: Record<
  Exclude<V2Runtime, "hermes">,
  { viewBox: string; d: string; color?: string }
> = {
  "claude-code": { ...CLAUDE_MARK, color: "#D97757" },
};

/* A runtime's mark on a small rounded tile, so every runtime reads the same
   size and weight next to each other. `bare` drops the tile (inline in text). */
export function RuntimeIcon({
  runtime,
  className,
  bare,
}: {
  runtime: V2Runtime;
  className?: string;
  bare?: boolean;
}) {
  const label = RUNTIME_NAME[runtime];
  const tile = cn(
    "inline-grid size-5 shrink-0 place-items-center overflow-hidden",
    !bare && "rounded-[6px] bg-background ring-1 ring-foreground/10",
    className,
  );
  if (runtime === "hermes")
    return (
      <span role="img" aria-label={label} title={label} className={tile}>
        <img src={hermesLogo} alt="" className="size-full dark:invert" />
      </span>
    );
  const m = MARK[runtime];
  return (
    <span role="img" aria-label={label} title={label} className={tile}>
      <svg
        viewBox={m.viewBox}
        aria-hidden
        className={cn("size-[70%]", !m.color && "text-foreground")}
        style={m.color ? { color: m.color } : undefined}
      >
        <path d={m.d} fill="currentColor" />
      </svg>
    </span>
  );
}
