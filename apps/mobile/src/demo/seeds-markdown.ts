import type { SeedConversation } from "./types";

/* s-markdown — the renderer testbed thread, verbatim from the prototype
   (fake-team.ts): seven fence kinds then three tables incl. long
   Vietnamese cells. The reply text is the payload; no tools needed. */

const FENCES = `Here's the change set — seven blocks, each its own kind:

The handler in TypeScript:

\`\`\`ts
export async function resolveRoute(path: string): Promise<Route> {
  // keep the trailing slash stable — the web router depends on it
  const normalized = path.replace(/\\/+$/, "") || "/";
  return match(normalized);
}
\`\`\`

Same shape in Python:

\`\`\`python
def resolve_route(path: str) -> Route:
    # keep the trailing slash stable
    normalized = re.sub(r"/+$", "", path) or "/"
    return match(normalized)
\`\`\`

And the bash one-liner for ops:

\`\`\`bash
curl -fsSL https://relay.local/health | jq -e '.ok == true'
\`\`\`

The config payload — one long line, no breaks:

\`\`\`json
{"relay":{"host":"127.0.0.1","port":4577,"tls":false,"retry":{"attempts":8,"backoffMs":[300,600,1200,2400]},"features":{"phonePairing":true,"pushNotifications":true,"workbench":{"terminal":true,"diffs":true,"previews":false}}}}
\`\`\`

This fence holds markdown-looking text that must stay literal:

\`\`\`markdown
| not | a | table |
| --- | --- | --- |
**not bold** and - not a bullet and \`not inline code\`
\`\`\`

An unlabelled block with indented content:

\`\`\`
    step one: fetch the token
      step two: pair the device
        step three: listen on :4577
\`\`\`

Finally the diff for the change itself:

\`\`\`diff
@@ -3,6 +3,7 @@
 const route = match(path);
-  return route.withFallback();
+  return route.strict();
+  // fallback moved to the caller (#259)
\`\`\`

Each block keeps its own shape — mono, panel, copy — the thread prose around them stays normal.`;

const TABLES = `Two open items — here's the breakdown:

| Issue | What it needs |
| --- | --- |
| Apple review reply | Cần trả lời reviewer trong 24h — họ hỏi về quyền camera, cần giải thích pairing flow chứ không phải quét ảnh. |
| Sam's invoice | Hóa đơn tháng 9 chưa chốt — cần xác nhận số giờ trước khi gửi lại cho kế toán cuối tuần này. |

And a wider one for scroll:

| Slice | AC | Tier | Status | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
| #259 code blocks | 5 | Normal | In PR | Devin | fences + highlight + copy |
| #306 tables | 6 | Normal | **Building** | Devin | GFM tables, scroll inside the message |
| #307 desktop chrome | 7 | Normal | \`agent-ready\` | unassigned | Shiki plugin + one-row header |

Alignment matters too — right, center, left:

| Rank | Name | Score |
| ---: | :---: | :--- |
| 1 | Relay | 98.2 |
| 12 | Harness | 87.04 |
| 123 | Desktop | 76.345 |

Everything outside the tables renders as normal prose.`;

export const SEED_MARKDOWN: SeedConversation = {
  id: "s-markdown",
  title: "Markdown rendering QA",
  channelId: "ch-builder",
  session: "ses_7f3d",
  cwd: "~/Desktop/Oscar/LilOS",
  model: "claude-sonnet-5",
  provider: "anthropic-cliproxy",
  effort: "medium",
  ageMin: 60 * 4,
  legs: [
    {
      text: "Send me the markdown sample — every fenced block kind in one reply.",
      script: {
        reasoning:
          "The seven-block sample verbatim — ts, python, bash, a long JSON line, markdown inside a fence, an unlabelled block and a diff.",
        text: FENCES,
        usage: {
          input: 5600,
          output: 1900,
          reasoning: 400,
          cache: 2200,
          context: 7_500,
        },
      },
    },
    {
      text: "Now the table sample — the open-items breakdown, the wide one, and the aligned one.",
      script: {
        reasoning:
          "The three-table sample verbatim — a two-column breakdown with long Vietnamese cell text, a six-column status table that needs horizontal scroll, and a right/center/left aligned one.",
        text: TABLES,
        usage: {
          input: 3500,
          output: 1500,
          reasoning: 300,
          cache: 1100,
          context: 5_000,
        },
      },
    },
  ],
};
