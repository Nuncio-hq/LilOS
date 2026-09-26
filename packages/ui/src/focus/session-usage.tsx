import type { LanguageModelUsage } from "ai";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
} from "../components/ai-elements/context";
import type { Usage } from "../types";

/* Token/context meter for one Hermes session (AI Elements Context). */
export function SessionUsage({
  usage,
  model,
}: {
  usage: Usage;
  model: string;
}) {
  const used = usage.input + usage.output;
  const max = model.startsWith("qwen") ? 262_000 : 200_000;
  const u: LanguageModelUsage = {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: used,
    inputTokenDetails: {
      noCacheTokens: usage.input - usage.cache,
      cacheReadTokens: usage.cache,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: {
      textTokens: usage.output - usage.reasoning,
      reasoningTokens: usage.reasoning,
    },
  };
  const n = (x: number) =>
    new Intl.NumberFormat("en-US", { notation: "compact" }).format(
      Math.round(x),
    );
  return (
    <Context usedTokens={used} maxTokens={max} usage={u}>
      <ContextTrigger size="sm" className="h-7 px-1.5 text-xs" />
      <ContextContent>
        <ContextContentHeader />
        <ContextContentBody className="space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Input</span>
            <span>{n(usage.input)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Output</span>
            <span>{n(usage.output)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Reasoning</span>
            <span>{n(usage.reasoning)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Cache read</span>
            <span>{n(usage.cache)}</span>
          </div>
        </ContextContentBody>
        <ContextContentFooter>
          <span className="text-muted-foreground">Model</span>
          <span className="truncate">{model}</span>
        </ContextContentFooter>
      </ContextContent>
    </Context>
  );
}
