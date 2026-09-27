/**
 * Deterministic canned turns — ported from the prototype's fake engine
 * (`prototype/web/src/App.tsx` scriptFor, attribution per AGENTS.md). Wall-clock
 * and Math.random are replaced by an injected counter so byte-for-byte the
 * same prompts produce the same script. `todo`/`pr` side-channels of the
 * prototype are UI concerns and stay out of the wire; their content is
 * carried by the tool steps and text.
 */
export interface FakeStep {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  diff?: {
    path: string;
    status: "added" | "modified" | "deleted";
    add: number;
    del: number;
    patch?: string;
  };
  commit?: {
    hash: string;
    message: string;
    files: { path: string; status: string; add: number; del: number }[];
  };
}

export interface FakeScript {
  reasoning: string;
  steps: FakeStep[];
  text: string;
}

const EDIT_ASK =
  /\b(add|fix|change|update|write|implement|refactor|bump|remove|rename|create|make|edit|move|delete|scaffold)\b/i;

/** What a prompt's image blocks carried — no pixel data crosses into a fake. */
export interface FakeImage {
  mimeType: string;
  sizeBytes: number;
}

export function scriptFor(
  agent: string,
  prompt: string,
  followUp: boolean,
  branch: string,
  nextHex: () => string,
  repo = "Nuncio-hq/LilOS",
  cwd = ".",
  images?: FakeImage[],
): FakeScript {
  const q = prompt
    .replace(/\*\*/g, "")
    .replace(/@\w+\s*/g, "")
    .trim()
    .replace(/[?.!]+$/, "");
  const tail = `I'm in \`${cwd}\` on ⎇ \`${branch}\`. Tell me what to change and I'll edit there.`;

  // `surfaces:` — the fake's way to really drive the app's surfaces for the
  // harness demos (#36): `surfaces: open <url>; run <cmd>; read; previews;
  // say <text>` becomes mcp__lilos__* steps that the engine executes against
  // the session's attached MCP server for real.
  const surf = /^surfaces:\s*(.*)$/is.exec(q);
  if (surf) {
    const steps: FakeStep[] = [];
    for (const raw of surf[1].split(";")) {
      const op = raw.trim();
      const m = /^(\w[\w-]*)\s*(.*)$/s.exec(op);
      if (!m) continue;
      const [, verb, rest] = m;
      const arg = rest.trim();
      const tool = (name: string) => `mcp__lilos__${name}`;
      switch (verb) {
        case "open":
          steps.push({
            tool: tool("browser_open"),
            input: { url: arg },
            output: "",
          });
          break;
        case "click":
          steps.push({
            tool: tool("browser_click"),
            input: { selector: arg },
            output: "",
          });
          break;
        case "type": {
          const tm = /^(\S+)\s+(.*)$/s.exec(arg);
          steps.push({
            tool: tool("browser_type"),
            input: tm ? { selector: tm[1], text: tm[2] } : { text: arg },
            output: "",
          });
          break;
        }
        case "read":
          steps.push({ tool: tool("browser_read"), input: {}, output: "" });
          break;
        case "scroll":
          steps.push({
            tool: tool("browser_scroll"),
            input: { dy: Number(arg) || 300 },
            output: "",
          });
          break;
        case "eval":
          steps.push({
            tool: tool("browser_eval"),
            input: { expression: arg },
            output: "",
          });
          break;
        case "run":
          steps.push({
            tool: tool("terminal_run"),
            input: { command: arg },
            output: "",
          });
          break;
        case "write":
          steps.push({
            tool: tool("terminal_write"),
            input: { data: arg },
            output: "",
          });
          break;
        case "term":
          steps.push({ tool: tool("terminal_read"), input: {}, output: "" });
          break;
        case "previews":
          steps.push({ tool: tool("previews_list"), input: {}, output: "" });
          break;
        case "say":
          steps.push({
            tool: tool("app_post_message"),
            input: { text: arg },
            output: "",
          });
          break;
        case "conv":
          steps.push({
            tool: tool("app_read_conversation"),
            input: {},
            output: "",
          });
          break;
      }
    }
    return {
      reasoning: `Driving the session's surfaces via the LilOS MCP tools: ${surf[1].trim()}.`,
      steps,
      text: `Ran the surface ops. Outputs are on each tool call.`,
    };
  }

  // Issue #31: image prompts get their own script so the answer names what
  // arrived (mimeType + bytes) — the reference AC-2 can assert.
  if (images?.length) {
    const list = images
      .map((img) => `${img.mimeType} (${img.sizeBytes} bytes)`)
      .join(", ");
    return {
      reasoning: `Oscar attached ${images.length === 1 ? "an image" : `${images.length} images`} to the prompt: ${list}. It rode in as image content blocks; answer about ${q ? `"${q}"` : "it"} citing what arrived.`,
      steps: [
        {
          tool: "view_image",
          input: {
            count: images.length,
            mimeTypes: images.map((img) => img.mimeType),
            bytes: images.reduce((sum, img) => sum + img.sizeBytes, 0),
          },
          output: `decoded ${list}`,
        },
      ],
      text: `Got your image${images.length > 1 ? "s" : ""} — ${list} came through as a prompt content block.${q ? ` On "${q}":` : ""} a vision model describes the pixels; this fake proves the hand-off.`,
    };
  }

  if (/\b(open|create|raise)\b.*\b(pr|pull request)\b/i.test(q)) {
    const n = 12;
    const title = "LIL-3: scaffold pnpm monorepo";
    return {
      reasoning: `Branch ${branch} is committed and green. Push it, open the PR against main with a summary + how I verified, request Reviewer.`,
      steps: [
        {
          tool: "terminal",
          input: { command: `git push -u origin ${branch}` },
          output: `To github.com:${repo}.git\n * [new branch]      ${branch} -> ${branch}`,
        },
        {
          tool: "terminal",
          input: {
            command: `gh pr create --base main --head ${branch} --title "${title}" --reviewer reviewer`,
          },
          output: `https://github.com/${repo}/pull/${n}`,
        },
      ],
      text: `Opened **PR #${n}** against \`main\` and requested **@Reviewer**.\n\nI'm watching CI and review comments from this session; status is live on the card below.`,
    };
  }

  if (EDIT_ASK.test(q)) {
    const h = nextHex();
    return {
      reasoning: `On ⎇ ${branch}, so I can edit. Smallest change for "${q}", then re-run the tests and commit on the branch.`,
      steps: [
        {
          tool: "search_files",
          input: { pattern: "## Notes", path: "README.md" },
          output: "0 matches",
        },
        {
          tool: "patch",
          input: { path: "README.md" },
          output: "+3 lines",
          diff: {
            path: "README.md",
            status: "modified",
            add: 3,
            del: 0,
            patch: `@@ -46,3 +46,6 @@\n - \`packages/client-runtime\` state + reducer, no DOM\n - \`apps/web\`, \`apps/relay\`\n+\n+## Notes\n+- ${q}`,
          },
        },
        {
          tool: "write_file",
          input: { path: "docs/decisions/0002-notes.md" },
          output: "9 lines",
          diff: {
            path: "docs/decisions/0002-notes.md",
            status: "added",
            add: 5,
            del: 0,
            patch: `@@ -0,0 +1,5 @@\n+# 0002 ${q}\n+\nStatus: proposed\n+\nWhy: asked by Oscar in session.`,
          },
        },
        {
          tool: "terminal",
          input: { command: "pnpm -r test" },
          output:
            "[32m✓[0m contracts (4)\n[32m✓[0m client-runtime (3)\n[33m↓[0m relay (1 skipped)\n\nTests  7 passed | 1 skipped (8)\nTime   1.38s",
        },
        {
          tool: "terminal",
          input: { command: `git commit -am "${q}"` },
          output: `[${branch} ${h}] ${q}\n 2 files changed, 8 insertions(+)`,
          commit: {
            hash: h,
            message: q,
            files: [
              { path: "README.md", status: "modified", add: 3, del: 0 },
              {
                path: "docs/decisions/0002-notes.md",
                status: "added",
                add: 5,
                del: 0,
              },
            ],
          },
        },
      ],
      text: `Done on \`${branch}\`:\n\n- \`README.md\` +3, new \`docs/decisions/0002-notes.md\`\n- Tests: 7 passed, 1 skipped\n- Commit \`${h}\`\n\nReview it in **Changes**.`,
    };
  }

  if (followUp) {
    return {
      reasoning: `Follow-up in the same session. Earlier turns are already in context, so no re-reading. Fold "${q}" into the plan.`,
      steps: [
        {
          tool: "read_file",
          input: { path: "packages/contracts/src/envelope.ts" },
          output: "cached · 58 lines",
        },
      ],
      text: `Noted. Plan for this session now:\n\n1. On reconnect, send \`afterSequence\` = last \`seq\`\n2. ${q[0].toUpperCase() + q.slice(1)}\n\n${tail}`,
    };
  }

  if (agent === "marketer") {
    return {
      reasoning: `Oscar asks: "${q}". Audience is indie founders running AI agents. Check what is already out there, then write in his voice: plain, concrete, no hype.`,
      steps: [
        {
          tool: "web_search",
          input: { query: "AI employees for solo founders" },
          output: "5 results",
        },
        {
          tool: "write_file",
          input: { path: "drafts/notes.md" },
          output: "212 words",
        },
      ],
      text: `First pass:\n\n1. *Your company in one chat.*\n2. *Hire agents like people. Fire them like software.*\n3. *Employees that show their work.*\n\nI would lead with 3. It says what is different without a claim we can't back. Notes saved to \`drafts/notes.md\`.`,
    };
  }

  if (agent === "reviewer") {
    return {
      reasoning: `Question: "${q}". Read-only on main. Look at recent diffs and the package graph before answering.`,
      steps: [
        {
          tool: "terminal",
          input: { command: "git log -5 --stat main" },
          output: "5 commits · 23 files",
        },
        {
          tool: "search_files",
          input: { pattern: 'from "react"', path: "packages/client-runtime" },
          output: "0 matches",
        },
      ],
      text: `No boundary leaks. \`client-runtime\` has zero DOM or React imports. Two gaps:\n\n- \`apps/relay\` has no tests at all\n- the envelope \`seq\` is never asserted to be monotonic\n\nI can write both up as review comments.`,
    };
  }

  return {
    reasoning: `Oscar asks: "${q}". Session cwd is ${cwd}. Read first, then answer short with file references.`,
    steps: [
      {
        tool: "search_files",
        input: {
          pattern: q.split(" ").slice(0, 2).join(" ") || "relay",
          path: ".",
        },
        output: "4 matches",
      },
      {
        tool: "read_file",
        input: { path: "packages/contracts/src/envelope.ts" },
        output: "58 lines",
      },
      {
        tool: "terminal",
        input: { command: "pnpm -r typecheck" },
        output: "4 projects · 0 errors",
      },
    ],
    text: `Short answer:\n\n- The contracts already carry \`seq\`, so replay needs no new endpoint. See \`envelope.ts:12\`.\n- Typecheck is clean across 4 packages.\n\nIf you want me to change code, pick a folder when you open the session, or press **Start work** on a channel thread.`,
  };
}
