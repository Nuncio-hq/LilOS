/**
 * Deterministic canned turns — ported from the prototype's fake engine
 * (`prototype/web/src/App.tsx` scriptFor, attribution per AGENTS.md). Wall-clock
 * and Math.random are replaced by an injected counter so byte-for-byte the
 * same prompts produce the same script. `todo`/`pr` side-channels of the
 * prototype are UI concerns and stay out of the wire; their content is
 * carried by the tool steps and text.
 */
import {
  MARKDOWN_BLOCKS_SAMPLE,
  MARKDOWN_TABLE_SAMPLE,
} from "./markdown-samples.js";

/* ── subagents + background jobs (#179) ────────────────────────────────── */

/** One helper the delegate step spawns: its own tool calls nest under it. */
export interface FakeSubagent {
  /** Stable id; default `sa-<n>` per session. */
  id?: string;
  name: string;
  task: string;
  /** Scripts run to completion inside the step — no "running" outcome. */
  status: "done" | "failed" | "stopped";
  /** #309: an async delegate — the helper's subagent.completed lands after
      the parent's turn.completed, not inside the delegate step. */
  outlivesTurn?: boolean;
  steps: FakeStep[];
  result?: string;
  durationMs?: number;
  /** Agent id of the employee the helper is (AC-3); the engine links the
      subagent row to that employee's live session when one exists. */
  employee?: string;
}

/** A process the engine leaves running past the turn (job.* events). */
export interface FakeJob {
  id?: string;
  /** Defaults to the step's terminal command. */
  command?: string;
  /** Pumped one line per tick into job.output's rolling tail. */
  outputLines: string[];
  /** Emit job.exited after all lines (default: never — stays running). */
  exitCode?: number;
  /** Subagent name when a helper spawned it. */
  by?: string;
}

export interface FakeStep {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  /** #179: this call is a delegation — emit subagent.* for each helper. */
  subagents?: FakeSubagent[];
  /** #179: this call leaves a background process running (job.* events). */
  job?: FakeJob;
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

/** Oscar's 7-block code sample (#307). Kept identical to the copy in
    `prototype/web/src/App.tsx` — update both together. */
const CODEBLOCKS_SAMPLE = `Here is the code-block fixture — seven shapes in one reply.

A typed fence first, with a dimmed comment:

\`\`\`ts
// encode/decode helpers for the relay envelope
import { z } from "zod";

const Frame = z.object({ seq: z.number().int(), body: z.string() });
type Frame = z.infer<typeof Frame>;

export const encodeFrame = (f: Frame): string => JSON.stringify(f); // one frame per line
\`\`\`

Python, the ops-script twin:

\`\`\`python
# same envelope, for the ops scripts
import json

def encode_frame(seq: int, body: str) -> str:
    """One frame per line, compact separators."""
    return json.dumps({"seq": seq, "body": body}, separators=(",", ":"))
\`\`\`

Bash:

\`\`\`bash
bun run relay --port 4577 && curl -s localhost:4577/health
\`\`\`

The payload the relay logs is a single unbroken line — it must scroll inside the block, never the column:

\`\`\`json
{"seq":1042,"kind":"msg","channel":"dm-builder","from":"builder","to":"ada","text":"envelope contract looks good","attachments":[],"meta":{"engine":"fake","tier":"normal","trace":"9f3ac2e1"},"at":1759128000000,"checksum":"sha256:aa91f0e3c9b2d4a5f6e7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9"}
\`\`\`

This fence is full of markdown-looking text — it has to stay literal:

\`\`\`markdown
## Not a real heading
- **not bold** and \`not code\`
| tables | don't | render |
\`\`\`

    this is just an indented block with no fence at all
    four spaces in, three lines, monospace, unstyled

And the patch shape — red and green line backgrounds:

\`\`\`diff
@@ -8,7 +8,9 @@ export const encodeFrame = (f: Frame): string =>
   const frame = JSON.stringify(f);
-  return frame.replace(/\\n/g, " ");
+  // frames must stay one-per-line
+  if (frame.includes("\\n")) throw new Error("newline in frame");
+  return frame;
\`\`\`
`;

export function scriptFor(
  agent: string,
  prompt: string,
  followUp: boolean,
  branch: string,
  nextHex: () => string,
  repo = "Nuncio-hq/LilOS",
  cwd = ".",
  images?: FakeImage[],
  /* #134: every earlier user turn the session remembers — the `recall:` leg
     echoes them verbatim so a test can prove `session.rewind` dropped the
     tail from the agent's context (not just from the rendered thread). */
  history?: string[],
): FakeScript {
  /* Employee `@Mentions` are stripped for the reply's readable gist; file
     mentions (`@dir/file.ext` — the token continues past `\w`, #105) stay
     verbatim so the echo proves the engine got the path as plain text. */
  const q = prompt
    .replace(/\*\*/g, "")
    .replace(/@\w+(?![\w./-])\s*/g, "")
    .trim()
    .replace(/[?.!]+$/, "");
  const tail = `I'm in \`${cwd}\` on ⎇ \`${branch}\`. Tell me what to change and I'll edit there.`;

  /* `md: blocks` / `md: table` — Oscar's markdown sample replies verbatim
     (#259/#306 legs: what the mobile Prose does with them is the point). */
  const md = /^md(?:arkdown)?:\s*(blocks|table)/i.exec(q);
  if (md) {
    return {
      reasoning: `The ${md[1].toLowerCase()} markdown sample, verbatim — its rendering is what gets judged.`,
      steps: [],
      text:
        md[1].toLowerCase() === "table"
          ? MARKDOWN_TABLE_SAMPLE
          : MARKDOWN_BLOCKS_SAMPLE,
    };
  }

  /* `codeblocks` — Oscar's 7-block markdown sample (#307): ts, python, bash,
     a long unbroken JSON line, markdown-looking text inside a fence, an
     unlabelled indented block and a diff. The desktop code-block fixture;
     identical to the prototype's copy in `prototype/web/src/App.tsx`. */
  if (/\bcode ?blocks?\b/i.test(q)) {
    return {
      reasoning: `Code-block rendering check — answer with the 7-block sample: a typed fence, python, bash, a long unbroken JSON line, markdown-looking text in a fence, an unlabelled indented block and a diff.`,
      steps: [],
      text: CODEBLOCKS_SAMPLE,
    };
  }

  /* `recall:` — echo the turns the session still remembers (#134 AC-2).
     After a rewind to turn N this answer must name only turns 1..N. */
  if (/^recall:/i.test(q)) {
    const remembered = (history ?? []).map((t) =>
      t.replace(/\s+/g, " ").trim().slice(0, 60),
    );
    return {
      reasoning: "Rewind check: list every earlier turn still in context.",
      steps: [
        {
          tool: "terminal",
          input: { command: "history --turns" },
          output: `${remembered.length} remembered turn(s)`,
        },
      ],
      text: `I remember ${remembered.length} earlier turn${remembered.length === 1 ? "" : "s"}:\n${remembered.map((t, i) => `${i + 1}. ${t}`).join("\n") || "-"}

${tail}`,
    };
  }

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

  /* #179: delegation — three helpers, the middle one fails; an @mention of
     another employee tags that helper as an employee-helper (the engine
     links it to their live session when one exists). `LILOS_DELEGATE` is
     the conformance/live-stub key. */
  if (/\bdelegate|subagents?\b/i.test(q)) {
    const mention = /@(\w+)(?![\w./-])/.exec(prompt)?.[1];
    const helpers: FakeSubagent[] = [
      {
        name: "Scan the relay package",
        task: "List the relay package's exported surface and report it back.",
        status: "done",
        durationMs: 3200,
        result:
          "Relay exports `client` + `server`; one envelope shape over the wire.",
        steps: [
          {
            tool: "search_files",
            input: { pattern: "export", path: "apps/relay/src" },
            output: "4 matches",
          },
          {
            tool: "read_file",
            input: { path: "apps/relay/src/session.ts" },
            output: "392 lines",
          },
        ],
      },
      {
        name: "Verify the findings",
        task: "Cross-check the scan's claims against the workspace tree.",
        status: "failed",
        durationMs: 1400,
        result: "workspace probe timed out",
        steps: [
          {
            tool: "terminal",
            input: { command: "git status --porcelain" },
            output: "fatal: not a git repository",
          },
        ],
      },
      {
        name: "Draft the summary",
        task: "Write the one-paragraph summary of the helpers' findings.",
        status: "done",
        durationMs: 900,
        result: "Summary written to notes/summary.md.",
        steps: [
          {
            tool: "write_file",
            input: { path: "notes/summary.md" },
            output: "12 lines",
            diff: {
              path: "notes/summary.md",
              status: "added",
              add: 12,
              del: 0,
              patch:
                "@@ -0,0 +1,12 @@\n+# Relay summary\n+\n+One envelope over the wire; helpers agree.",
            },
          },
        ],
      },
    ];
    /* AC-3: a helper that is another employee is declared by an @mention —
       the engine resolves their live session at emit time. */
    if (mention && mention !== agent) helpers[2].employee = mention;
    /* #309: LILOS_DELEGATE_ASYNC marks the first helper async — its
       subagent.completed lands after turn.completed (dispatch-receipt
       delegation). */
    if (/\bLILOS_DELEGATE_ASYNC\b/i.test(prompt))
      helpers[0].outlivesTurn = true;
    return {
      reasoning: `Three separable reads. Fan out helpers and fold their reports back.`,
      steps: [
        {
          tool: "delegate_task",
          input: {
            tasks: helpers.map((h) => ({ goal: h.task })),
          },
          output: "",
          subagents: helpers,
        },
      ],
      text: `All three helpers reported back — one failed (workspace probe), the other two landed. Their steps and reports are on each row.`,
    };
  }

  /* #179: background work — `LILOS_BG_EXIT` is the conformance key for a
     bounded job that exits on its own; `LILOS_BG`/"background"/"dev server"
     keys a long-running process (stays running until jobs.stop). */
  if (/\bLILOS_BG_EXIT|background build\b/i.test(q)) {
    return {
      reasoning: `A bounded build belongs in the background — its row updates until it exits.`,
      steps: [
        {
          tool: "terminal",
          input: { command: "bun run build &" },
          output: "Background process started",
          job: {
            command: "bun run build",
            outputLines: [
              "$ bun run build",
              "bundling 214 modules…",
              "✓ build finished in 1.9s",
            ],
            exitCode: 0,
          },
        },
      ],
      text: `The build ran in the background and exited clean — the **Background** row shows it.`,
    };
  }
  if (/\bLILOS_BG\b|background|dev server/i.test(q)) {
    return {
      reasoning: `A dev server runs past this turn — leave it in the background so **Stop** can end it.`,
      steps: [
        {
          tool: "terminal",
          input: { command: "bun run dev &" },
          output: "Background process started",
          job: {
            command: "bun run dev",
            outputLines: [
              "$ bun run dev",
              "vite v7 ready in 412 ms",
              "Local: http://localhost:4173/",
              "watching for changes…",
              "GET / 200 12ms",
              "GET / 200 9ms",
            ],
          },
        },
      ],
      text: `Dev server is up — it's listed under **Background** with its URL and output; **Stop** kills it.`,
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
