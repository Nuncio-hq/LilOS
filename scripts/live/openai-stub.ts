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

const server = Bun.serve({
  /* `0` = kernel picks a free port — live scripts pass it and read the
     bound port off this line so a stale process can't shadow the stub. */
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
        messages?: { role?: string; content?: unknown }[];
        /* #92: the pick fields live scripts assert on — fast tier rides
           `service_tier` (OpenAI/xAI) or `speed` (Anthropic); effort rides
           `reasoning_effort` (or a `reasoning` object on Anthropic-style). */
        service_tier?: string;
        speed?: string;
        reasoning_effort?: string;
        reasoning?: { effort?: string };
        /* #137: Hermes' auto-titler constrains replies with
           `response_format: {type:"json_schema", json_schema:{name:"session_title"}}`
           — answer it so the llm title stage exercises end to end. */
        response_format?: {
          type?: string;
          json_schema?: { name?: string };
        };
      };
      const model = body.model ?? "stub-model";
      const flatText = (c: unknown): string =>
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? (c as { type?: string; text?: string }[])
                .filter((p) => p?.type === "text")
                .map((p) => p.text ?? "")
                .join(" ")
            : "";
      /* The title task is a one-shot non-streaming call; answer it with a
         deterministic schema-valid title derived from the opener. */
      if (body.response_format?.json_schema?.name === "session_title") {
        const opener = [...(body.messages ?? [])]
          .reverse()
          .find((m) => m.role === "user");
        const words = flatText(opener?.content)
          .replace(/\s+/g, " ")
          .trim()
          .split(" ")
          .filter(Boolean)
          .slice(0, 5);
        const title =
          words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") ||
          "Untitled session";
        return Response.json({
          id: "chatcmpl-stub",
          object: "chat.completion",
          created: 0,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({ title }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
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
        const line = `${JSON.stringify({ model, service_tier: body.service_tier, speed: body.speed, reasoning_effort: body.reasoning_effort ?? body.reasoning?.effort, image_parts: images.length, content_blocks: parts.length, text_sample: texts.join(" ").slice(0, 300), texts })}\n`;
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
console.log(`openai-stub listening on http://127.0.0.1:${server.port}/v1`);
