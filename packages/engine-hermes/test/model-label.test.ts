import { describe, expect, test } from "vitest";
import { displayModelName, modelDisplayParts } from "../src/model-label.js";

/* AC-4 naming table — cases ported from NousResearch/hermes-agent
   `apps/desktop/src/lib/model-status-label.test.ts` (MIT), the same fixture
   the Hermes Desktop picker asserts on. */
describe("model-label (issue #194 AC-4)", () => {
  test("strips trailing date-pin snapshots and dots hyphenated Anthropic versions", () => {
    expect(displayModelName("claude-opus-4-5-20251101")).toBe("Opus 4.5");
    expect(displayModelName("anthropic/claude-haiku-4-5-20251001")).toBe(
      "Haiku 4.5",
    );
    expect(displayModelName("claude-fable-5-1")).toBe("Fable 5.1");
  });

  test("renders the Anthropic 1M-context route suffix as a tag, never raw brackets", () => {
    expect(modelDisplayParts("claude-sonnet-5[1m]")).toEqual({
      name: "Sonnet 5",
      tag: "1M",
    });
    expect(modelDisplayParts("claude-fable-5-1[1m]")).toEqual({
      name: "Fable 5.1",
      tag: "1M",
    });
    expect(displayModelName("claude-opus-5[1m]")).not.toContain("[");
  });

  test("renders local GGUF ids as a clean name with a quant tag", () => {
    expect(modelDisplayParts("Qwen3.6-27B-UD-Q4_K_XL")).toEqual({
      name: "Qwen3.6 27B",
      tag: "Q4",
    });
    expect(modelDisplayParts("Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL")).toEqual({
      name: "Nemotron 3 Nano 30B A3B",
      tag: "Q4",
    });
    expect(modelDisplayParts("Qwen3-4B-Instruct-2507-UD-Q8_K_XL")).toEqual({
      name: "Qwen3 4B",
      tag: "Q8",
    });
    expect(modelDisplayParts("some-model-Q6_K")).toEqual({
      name: "Some Model",
      tag: "Q6",
    });
    // Cloud ids keep their existing behavior.
    expect(modelDisplayParts("anthropic/claude-opus-4.8-fast").tag).toBe(
      "Fast",
    );
  });

  test("keeps the vendor casing the model id does not carry", () => {
    expect(displayModelName("glm-5.2")).toBe("GLM 5.2");
    expect(displayModelName("zai-org/glm-5.1")).toBe("GLM 5.1");
    expect(displayModelName("deepseek-v4-flash")).toBe("DeepSeek V4 Flash");
    expect(displayModelName("minimax/minimax-01")).toBe("MiniMax 01");
    expect(displayModelName("xiaomi/mimo-v2.5")).toBe("MiMo V2.5");
    expect(displayModelName("ernie-5.1")).toBe("ERNIE 5.1");
    expect(displayModelName("baai/bge-m3")).toBe("BGE M3");
    expect(displayModelName("openai")).toBe("OpenAI");
  });

  test("capitalises parameter counts the way vendors write them", () => {
    expect(displayModelName("qwen3-32b")).toBe("Qwen3 32B");
    expect(displayModelName("qwen/qwen3.5-35b-a3b")).toBe("Qwen3.5 35B A3B");
    expect(displayModelName("meta/llama-3.1-8b-instruct")).toBe(
      "Llama 3.1 8B Instruct",
    );
    expect(displayModelName("llama-3.1-8b-instruct-fp8")).toBe(
      "Llama 3.1 8B Instruct FP8",
    );
    expect(displayModelName("gemma-4-26b-a4b-it")).toBe("Gemma 4 26B A4B IT");
    expect(displayModelName("nemotron-nano-12b-v2-vl")).toBe(
      "Nemotron Nano 12B V2 VL",
    );
  });

  test("title-cases gemini names like every other branch", () => {
    expect(displayModelName("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
    expect(displayModelName("gemini-2.0-flash")).toBe("Gemini 2.0 Flash");
    expect(displayModelName("google/gemini-2.5-flash-lite")).toBe(
      "Gemini 2.5 Flash Lite",
    );
  });

  test("distinguishes the deepseek-flash alias from its deepseek-v4.1-flash sibling", () => {
    // models.dev carries both ids for the provider: `deepseek-flash` (alias)
    // and `deepseek-v4.1-flash` (full id). Two distinct ids must never render
    // as near-identical tagless rows the user reads as one model listed twice.
    expect(modelDisplayParts("deepseek-flash")).toEqual({
      name: "DeepSeek",
      tag: "Flash",
    });
    expect(modelDisplayParts("deepseek-v4.1-flash")).toEqual({
      name: "DeepSeek V4.1",
      tag: "Flash",
    });
    expect(modelDisplayParts("deepseek-v4.1")).toEqual({
      name: "DeepSeek V4.1",
      tag: "",
    });
  });

  test("keeps the variant tag in the display name so distinct ids never collapse", () => {
    expect(displayModelName("anthropic/claude-opus-4.8-fast")).toBe(
      "Opus 4.8 Fast",
    );
    expect(displayModelName("deepseek/deepseek-v4-pro-thinking")).toBe(
      "DeepSeek V4 Pro Thinking",
    );
    expect(displayModelName("gpt-5.5-preview")).toBe("GPT-5.5 Preview");
    expect(displayModelName("claude-opus-5")).toBe("Opus 5");
    // A base model and its variant must NEVER share a display label.
    expect(displayModelName("claude-opus-5")).not.toBe(
      displayModelName("claude-opus-5-thinking"),
    );
    expect(displayModelName("Qwen3.6-27B-UD-Q4_K_XL")).toBe("Qwen3.6 27B Q4");
    expect(displayModelName("claude-sonnet-5[1m]")).toBe("Sonnet 5 1M");
  });

  test("a variant and a quant decompose identically in either suffix order", () => {
    expect(modelDisplayParts("Qwen3.6-27B-flash-Q4_K_XL")).toEqual({
      name: "Qwen3.6 27B",
      tag: "Flash Q4",
    });
    expect(modelDisplayParts("Qwen3.6-27B-Q4_K_XL-flash")).toEqual({
      name: "Qwen3.6 27B",
      tag: "Flash Q4",
    });
    expect(modelDisplayParts("Qwen3.6-27B-Q8_0")).toEqual({
      name: "Qwen3.6 27B",
      tag: "Q8",
    });
  });

  test("every distinct catalog id maps to a distinct label (no collisions)", () => {
    // The real Hermes catalog shapes Oscar hits: look-alike pairs must never
    // collapse to one label on any surface.
    const ids = [
      "claude-opus-4.8",
      "claude-opus-4.8-fast",
      "claude-opus-4.8-thinking",
      "claude-sonnet-5",
      "claude-sonnet-5[1m]",
      "claude-opus-4-5-20251101",
      "gpt-6-sol",
      "gpt-6-sol-900k",
      "gemini-2.5",
      "gemini-2.5-flash",
      "deepseek-flash",
      "deepseek-v4.1-flash",
      "deepseek-v4.1",
      "qwen3.8-flash-next",
      "devin/claude-opus-5",
      "devin/kimi-k3",
      "zai-org/glm-5.2",
    ];
    const labels = ids.map(displayModelName);
    expect(new Set(labels).size).toBe(ids.length);
  });
});
