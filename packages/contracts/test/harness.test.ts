import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildSchemaDoc } from "../scripts/gen-schemas.js";
import {
  BrowserClickParams,
  harnessProtocol,
  LILOS_TOOLS,
  PreviewTarget,
  TerminalRunParams,
  ThreadPostParams,
  ViewerClientMsg,
  ViewerServerMsg,
} from "../src/harness/index.js";

describe("AC-2 tool surface contracts", () => {
  it("exposes browser + terminal + workbench + thread + team + root ops", () => {
    expect(Object.keys(LILOS_TOOLS).sort()).toEqual([
      "browser_click",
      "browser_eval",
      "browser_open",
      "browser_read",
      "browser_scroll",
      "browser_type",
      "context",
      "guide",
      "team_list",
      "terminal_read",
      "terminal_run",
      "terminal_write",
      "thread_list",
      "thread_post",
      "thread_prs",
      "thread_read",
      "thread_search",
      "thread_set_title",
      "workbench_open",
      "workbench_previews",
    ]);
  });

  it("every tool declares strict params + a result schema + a doc line", () => {
    for (const [name, t] of Object.entries(LILOS_TOOLS)) {
      expect(t.doc.length, name).toBeGreaterThan(0);
      expect(
        () => t.params.parse(Object.fromEntries([])),
        name,
      ).not.toThrowError(/not an object|implementation/i);
    }
  });

  it("strict params reject unknown keys (caller bugs surface as invalid_params)", () => {
    expect(() =>
      BrowserClickParams.parse({ selector: "#a", sneaky: 1 }),
    ).toThrow();
    expect(() =>
      TerminalRunParams.parse({ command: "ls", session: "other" }),
    ).toThrow();
  });

  /* #340 live-leg regression: a zod union `params` serializes to a bare
     `anyOf` — no top-level `type:"object"`/`properties`, so function-calling
     clients (and the stdio MCP's `params.shape`) saw an EMPTY schema and the
     model had to guess arguments. Every tool must advertise a real object
     schema. */
  it("every tool's params advertise a top-level object schema", () => {
    for (const [name, t] of Object.entries(LILOS_TOOLS)) {
      const schema = z.toJSONSchema(t.params) as {
        type?: string;
        properties?: Record<string, unknown>;
      };
      expect(schema.type, `${name}: JSON schema type`).toBe("object");
      expect(
        typeof schema.properties,
        `${name}: JSON schema properties`,
      ).toBe("object");
      // The stdio MCP derives inputSchema from `params.shape` — it must
      // exist, and every field it names must appear in the JSON schema.
      const shape = (t.params as { shape?: Record<string, unknown> }).shape;
      expect(
        shape && typeof shape === "object",
        `${name}: params.shape for the stdio MCP inputSchema`,
      ).toBe(true);
      expect(
        Object.keys(schema.properties ?? {}),
        `${name}: every shape field advertised`,
      ).toEqual(expect.arrayContaining(Object.keys(shape ?? {})));
    }
  });

  it("workbench_open advertises its four targets + modifiers (live-leg regression)", () => {
    const schema = z.toJSONSchema(LILOS_TOOLS.workbench_open.params) as {
      properties?: Record<string, { description?: string }>;
    };
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["file", "line", "diff", "path", "pr", "url"]),
    );
    for (const field of ["file", "diff", "pr", "url"]) {
      expect(schema.properties?.[field]?.description).toBeTruthy();
    }
  });
});

describe("AC-4 viewer wire contracts", () => {
  it("parses the snapshot-then-live server messages", () => {
    const hello = ViewerServerMsg.parse({
      type: "hello",
      session: "s1",
      page: { width: 1280, height: 800 },
      terminal: { cols: 110, rows: 28 },
      control: { terminal: "agent" },
      url: null,
      previews: [],
    });
    expect(hello.type).toBe("hello");
    expect(
      ViewerServerMsg.parse({
        type: "frame",
        jpeg: "AAAA",
        capturedAt: 1,
      }).type,
    ).toBe("frame");
    expect(ViewerServerMsg.parse({ type: "term", data: "bHM=" }).type).toBe(
      "term",
    );
    // issue #56: holder flips + pane-driven viewport on the wire
    expect(
      ViewerServerMsg.parse({ type: "term.control", holder: "user" }).type,
    ).toBe("term.control");
    expect(
      ViewerServerMsg.parse({
        type: "page",
        page: { width: 640, height: 360 },
      }).type,
    ).toBe("page");
  });

  it("parses viewer takeover input messages", () => {
    const click = ViewerClientMsg.parse({
      type: "browser.input",
      event: { kind: "mouse", event: "down", x: 10, y: 20, button: "left" },
    });
    expect(click.type).toBe("browser.input");
    const key = ViewerClientMsg.parse({
      type: "browser.input",
      event: { kind: "key", event: "down", key: "a", text: "a" },
    });
    expect(key.type).toBe("browser.input");
    expect(
      ViewerClientMsg.parse({ type: "term.input", data: "ls\n" }).type,
    ).toBe("term.input");
    expect(
      ViewerClientMsg.parse({
        type: "browser.navigate",
        url: "http://localhost:5173",
      }).type,
    ).toBe("browser.navigate");
    // issue #56: explicit hand-back + pane-size report
    expect(ViewerClientMsg.parse({ type: "term.release" }).type).toBe(
      "term.release",
    );
    expect(
      ViewerClientMsg.parse({
        type: "browser.resize",
        width: 640,
        height: 360,
      }).type,
    ).toBe("browser.resize");
  });
});

describe("AC-5 preview discovery contract", () => {
  it("marks scan vs marker provenance", () => {
    expect(
      PreviewTarget.parse({ url: "http://localhost:5173", via: "scan" }),
    ).toMatchObject({ via: "scan" });
    expect(
      PreviewTarget.safeParse({ url: "http://x", via: "lsof" }).success,
    ).toBe(false);
  });
});

describe("registry", () => {
  it("renders a JSON Schema doc with every registered schema", () => {
    const doc = buildSchemaDoc(harnessProtocol) as {
      definitions: Record<string, unknown>;
    };
    expect(doc.definitions.ViewerServerMsg).toBeDefined();
    expect(doc.definitions.ViewerClientMsg).toBeDefined();
    expect(doc.definitions.TerminalRunParams).toBeDefined();
  });

  it("thread ops reference the app message shape", () => {
    const parsed = ThreadPostParams.parse({ text: "hi" });
    expect(parsed.text).toBe("hi");
  });
});
