import { Fragment } from "react";

/**
 * Plain status text with `backtick` spans rendered as inline code (#99).
 * Engine/harness reasons carry commands like `hermes update`; showing the raw
 * backticks reads like a typo and invites copying them. No other markdown.
 */
export function InlineCodeText({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code
            key={i}
            className="whitespace-nowrap rounded bg-foreground/[0.07] px-1 py-px font-mono text-[0.95em]"
          >
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
