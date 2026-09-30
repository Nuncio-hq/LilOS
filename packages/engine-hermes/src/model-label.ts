/**
 * Model-id → display-name rules, ported from NousResearch/hermes-agent
 * `apps/desktop/src/lib/model-status-label.ts` (MIT). Hermes' `model.options`
 * returns bare ids (`models: list[str]`); Hermes Desktop derives friendly
 * names client-side — LilOS ports the same rules so `models.list` can fill
 * `ModelOption.name` and every surface stays engine-neutral (#194). The id
 * itself is never split or rejoined for identity (#92 AC-8): `modelBaseId`
 * only feeds the LABEL.
 */

/** Strip a provider prefix and normalize for display. */
export function modelBaseId(model: string): string {
  const trimmed = model.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

// Trailing model-id variants that should render as a grayed tag beside the
// name (e.g. "Opus 4.8" + "Fast") rather than collapsing two distinct ids to
// the same display name. `-flash` splits look-alike pairs the same way
// (hermes-agent #118083): models.dev carries both `deepseek-flash` (alias)
// and `deepseek-v4.1-flash` (full id) for the provider.
const VARIANT_TAGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-fast$/i, "Fast"],
  [/-flash$/i, "Flash"],
  [/-thinking$/i, "Thinking"],
  [/-preview$/i, "Preview"],
  [/-latest$/i, "Latest"],
];

const titleCase = (text: string): string =>
  text.replace(/\b\w/g, (char) => char.toUpperCase()).trim();

// Vendors write their own names in casing the model id does not carry, and
// title-casing the id overrides it: `glm-5.2` reads as "Glm 5.2" instead of
// "GLM 5.2" (hermes-agent #85849). Applied AFTER title-casing so the rule is
// one pass over a normalized string, and only ever to whole words — `Minimax`
// never touches a longer token that merely contains it.
const VENDOR_CASING: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bDeepseek\b/g, "DeepSeek"],
  [/\bGlm\b/g, "GLM"],
  [/\bMinimax\b/g, "MiniMax"],
  [/\bOpenai\b/g, "OpenAI"],
  [/\bErnie\b/g, "ERNIE"],
  [/\bMimo\b/g, "MiMo"],
  [/\bBge\b/g, "BGE"],
  [/\bVl\b/g, "VL"],
  [/\bIt\b/g, "IT"],
  [/\bFp8\b/g, "FP8"],
  [/\bAi\b/g, "AI"],
];

// Parameter counts and active-parameter counts: vendors write 8B, 235B, A22B —
// never 8b. Matched after title-casing (so the token reads "8b" or "A3b"),
// case-insensitively so the title-cased "A" of "A3b" is still a prefix.
const PARAMETER_COUNT = /\b(a?)(\d+(?:\.\d+)?)b\b/gi;

const applyVendorCasing = (text: string): string => {
  let cased = text.replace(
    PARAMETER_COUNT,
    (_match, prefix: string, size: string) => `${prefix.toUpperCase()}${size}B`,
  );
  for (const [pattern, replacement] of VENDOR_CASING) {
    cased = cased.replace(pattern, replacement);
  }
  return cased;
};

function prettifyBase(base: string): string {
  if (/^claude-/i.test(base)) {
    // Anthropic ids spell the version with hyphens (`haiku-4-5`, `fable-5-1`);
    // the human name is dotted ("Haiku 4.5"), not "Haiku 4 5".
    return applyVendorCasing(
      titleCase(
        base
          .replace(/^claude-/i, "")
          .replace(/(\d)-(?=\d)/g, "$1.")
          .replace(/-/g, " "),
      ),
    );
  }

  if (/^gpt-/i.test(base)) {
    return base.replace(/^gpt-/i, "GPT-");
  }

  // Title-case this branch too: without it `gemini-2.5-pro` rendered as
  // "Gemini 2.5 pro" — the only branch that left its words lowercase.
  if (/^gemini-/i.test(base)) {
    return applyVendorCasing(
      titleCase(base.replace(/^gemini-/i, "Gemini ").replace(/-/g, " ")),
    );
  }

  return applyVendorCasing(titleCase(base.replace(/-/g, " ")));
}

// Split the trailing suffixes a local id can carry — a variant tag
// (`…-flash`, `…-fast`) and a GGUF quant (`…-UD-Q4_K_XL`, `…-Q8_0`) — in
// EITHER order: `…-flash-Q4_K_XL` and `…-Q4_K_XL-flash` are the same model.
// One decomposition feeds both the catalog rows and the composer pill, so
// the two screens can never disagree on which variant an id carries.
export function splitTrailingTags(base: string): {
  base: string;
  variant: string;
  quant: string;
} {
  let variant = "";
  let quant = "";

  for (let progress = true; progress; ) {
    progress = false;

    if (!variant) {
      for (const [pattern, label] of VARIANT_TAGS) {
        if (pattern.test(base)) {
          variant = label;
          base = base.replace(pattern, "");
          progress = true;
          break;
        }
      }
    }

    if (!quant) {
      const quantMatch = base.match(
        /-(?:UD-)?(Q\d(?:_[A-Z0-9]+)*|IQ\d(?:_[A-Z0-9]+)*|F16|BF16)$/i,
      );

      if (quantMatch) {
        quant = quantMatch[1].split("_")[0].toUpperCase();
        base = base.slice(0, -quantMatch[0].length);
        // Instruct/chat markers are noise once the quant confirmed a local build.
        base = base.replace(/-(?:Instruct|Chat)(?:-\d{4})?$/i, "");
        progress = true;
      }
    }
  }

  return { base, variant, quant };
}

/** Split a model id into a clean display name plus an optional grayed variant
 *  tag, so distinct ids (e.g. `…-4.8` vs `…-4.8-fast`) don't collapse. */
export function modelDisplayParts(model: string): {
  name: string;
  tag: string;
} {
  let { base, variant, quant } = splitTrailingTags(modelBaseId(model));

  const tags = [variant, quant].filter(Boolean);

  // Anthropic's `[1m]` route suffix selects the 1M-context window. It is a
  // variant of the same model, so it renders as a tag ("Sonnet 5 · 1M")
  // rather than raw brackets that read like an ANSI escape ("Sonnet 5[1m]").
  const contextWindow = base.match(/\[(\d+[mk])\]$/i);

  if (contextWindow) {
    tags.push(contextWindow[1].toUpperCase());
    base = base.slice(0, -contextWindow[0].length);
  }

  // Drop a trailing date-pin (`…-20251101`) — snapshot noise, not a name.
  base = base.replace(/-\d{8}$/, "");

  return {
    name: prettifyBase(base) || model.trim() || "No model",
    tag: tags.join(" "),
  };
}

/** Friendly one-line model name for menus and the status bar. The variant
 *  tag is part of the name: `…-4.8` vs `…-4.8-thinking` must never collapse
 *  to the same label on any surface (hermes-agent #88597). */
export function displayModelName(model: string): string {
  const { name, tag } = modelDisplayParts(model);
  return tag ? `${name} ${tag}` : name;
}

/** The context window an Anthropic-style `[1m]`/`[Nk]` route suffix in the
    model id selects — the same suffix `modelDisplayParts` renders as a tag
    (hermes-agent treats `sonnet-5[1m]` as the 1M-context variant). Ids
    without the suffix report nothing: Hermes `model.options` carries no
    per-model window, so the field is never guessed here — a session's own
    resolved window arrives on `usage.context_max` instead (#294). */
export function contextWindowFromId(model: string): number | undefined {
  const suffix = modelBaseId(model).match(/\[(\d+)([mk])\]$/i);
  if (!suffix) return undefined;
  const n = Number(suffix[1]);
  return suffix[2].toLowerCase() === "m" ? n * 1_000_000 : n * 1_000;
}
