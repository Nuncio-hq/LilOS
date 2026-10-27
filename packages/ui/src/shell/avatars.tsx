import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { cn } from "../lib/utils";
import type { Employee, Human } from "../types";
import { Avatar as FaceAvatar } from "../v3/v3-marks";
import { agentTone, runtimeLook } from "../v3/v3-model";

/* An agent's face wherever it appears (#872): the same letter-on-pastel
   the v3 sidebar and agent page draw — a coding-runtime agent wears its
   runtime's mark (Devin's "D" on blue), never a grey orb. An unknown id
   gets the gone-agent "?", not someone else's face. */
export function EmployeeAvatar({
  employee: e,
  size,
  className,
}: {
  employee: Pick<Employee, "name" | "runtime"> | undefined;
  size?: number;
  className?: string;
}) {
  if (!e)
    return <FaceAvatar name="?" tone="n" size={size} className={className} />;
  const mark =
    e.runtime && e.runtime !== "hermes" && e.runtime !== "default"
      ? runtimeLook(e.runtime)
      : undefined;
  return (
    <FaceAvatar
      name={mark?.label ?? e.name}
      tone={mark?.tone ?? agentTone(e.name)}
      size={size}
      className={className}
    />
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
