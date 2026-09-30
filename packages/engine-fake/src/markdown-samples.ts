/**
 * Oscar's sample agent replies for the mobile markdown work — the one
 * literal every surface renders so evidence is comparable: the #259 fenced
 * blocks leg (ts, python, bash, a long unbroken JSON line, markdown-looking
 * text inside a fence, an unlabelled indented block, a diff) and the #306
 * GFM table leg. Scripted replies key off `md: <name>` in script.ts; the
 * mobile prototype embeds the same literals in its mock thread.
 */

export const MARKDOWN_BLOCKS_SAMPLE = `Here's the change set — seven blocks, each its own kind:

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

export const MARKDOWN_TABLE_SAMPLE = `Two open items — here's the breakdown:

| Issue | What it needs |
| --- | --- |
| Apple review reply | Cần trả lời reviewer trong 24h — họ hỏi về quyền camera, cần giải thích pairing flow chứ không phải quét ảnh. |
| Sam's invoice | Hóa đơn tháng 9 chưa chốt — cần xác nhận số giờ trước khi gửi lại cho kế toán cuối tuần này. |

And a wider one for scroll:

| Slice | AC | Tier | Status | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
| #259 code blocks | 5 | Normal | In PR | Devin | fences + highlight + copy |
| #306 tables | 6 | Normal | Building | Devin | GFM tables, scroll inside the message |
| #307 desktop chrome | 7 | Normal | agent-ready | unassigned | Shiki plugin + one-row header |

Alignment matters too — right, center, left:

| Rank | Name | Score |
| ---: | :---: | :--- |
| 1 | Relay | 98.2 |
| 12 | Harness | 87.04 |
| 123 | Desktop | 76.345 |

Everything outside the tables renders as normal prose.`;
