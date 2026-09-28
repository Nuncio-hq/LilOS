/**
 * Deterministic OpenAI-compatible chat-completions stub for live runs.
 *
 *   bun scripts/live/openai-stub.ts [port]
 *
 * Serves POST /v1/chat/completions (stream + non-stream) and GET /v1/models.
 * Every request returns the same canned assistant reply; the model name is
 * echoed back. This exists so `hermes serve` runs for real (real WS/ACP
 * protocol, real supervision) without a signed-in LLM — the reply text is
 * fixed, so the label is always `stub`, never a live model.
 */
const port = Number(process.argv[2] ?? "8399");
const reply =
  process.env.STUB_REPLY ??
  "Done — I added the requested line to notes.txt (stub engine reply).";

const sse = (chunks: string[]) => chunks.join("");

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [{ id: "stub-model", object: "model" }],
      });
    }
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const body = (await req.json()) as {
        model?: string;
        stream?: boolean;
        messages?: { content?: unknown }[];
      };
      const model = body.model ?? "stub-model";
      // Live-image runs (issue #31): record whether the request carried image
      // parts so the runner can prove the screenshot reached the model side.
      if (process.env.STUB_REQUEST_LOG) {
        const parts = (body.messages ?? []).flatMap((m) =>
          Array.isArray(m.content) ? m.content : [],
        );
        const images = parts.filter(
          (p) =>
            typeof p === "object" &&
            p !== null &&
            (p as { type?: string }).type === "image_url",
        );
        const texts = (body.messages ?? []).map((m) =>
          (typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? (m.content as { type?: string; text?: string }[])
                  .filter((p) => p?.type === "text")
                  .map((p) => p.text ?? "")
                  .join(" ")
              : ""
          ).slice(0, 1000),
        );
        const line = `${JSON.stringify({ image_parts: images.length, content_blocks: parts.length, text_sample: texts.join(" ").slice(0, 300), texts })}\n`;
        const { appendFileSync } = await import("node:fs");
        appendFileSync(process.env.STUB_REQUEST_LOG, line);
      }
      if (body.stream) {
        const frame = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({
            id: "chatcmpl-stub",
            object: "chat.completion.chunk",
            created: 0,
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        return new Response(
          sse([
            frame({ role: "assistant", content: "" }, null),
            frame({ content: reply }, null),
            frame({}, "stop"),
            "data: [DONE]\n\n",
          ]),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({
        id: "chatcmpl-stub",
        object: "chat.completion",
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: reply },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    return new Response("openai-stub", { status: 404 });
  },
});
console.log(`openai-stub listening on http://127.0.0.1:${port}/v1`);
