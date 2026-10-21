import { describe, expect, it } from "vitest";
import {
  AppEventMethod,
  AppMethod,
  Conversation,
  Project,
  ProjectsCreateParams,
  ProjectsListParams,
  ProjectUpsertedEvent,
} from "../src/app/index.js";
import {
  AGENT_METHOD_TOOLS,
  LILOS_TOOLS,
  ProjectCreateParams,
  ThreadStartParams,
  toolsForAreas,
} from "../src/harness/index.js";

/* D-#771: projects on the wire and in the agent catalog. */

const project = {
  id: "proj_1",
  name: "LilOS",
  key: "LIL",
  folder: "/Users/ada/Code/LilOS",
  about: "The company OS.",
  createdAt: 1,
};

describe("D-#771 Project record", () => {
  it("is {id, name, key, folder, about, createdAt} with a short uppercase key", () => {
    expect(Project.parse(project)).toEqual(project);
    for (const key of ["lil", "", "TOOLONGKEY", "LI L", "LIL-1"]) {
      expect(Project.safeParse({ ...project, key }).success, key).toBe(false);
    }
    expect(Project.safeParse({ ...project, key: "LIL2" }).success).toBe(true);
  });

  it("is a thread's optional home — a plain chat has no projectId", () => {
    const thread = {
      id: "conv_1",
      channelId: "ch_1",
      rootMessageId: "msg_1",
      engineRef: null,
      state: "idle",
      title: "",
      archived: false,
      createdAt: 1,
    };
    expect(Conversation.parse(thread).projectId).toBeUndefined();
    expect(
      Conversation.parse({ ...thread, projectId: "proj_1" }).projectId,
    ).toBe("proj_1");
  });
});

describe("D-#771 wire", () => {
  it("declares projects.list / projects.create and the project.upserted event", () => {
    expect(AppMethod.safeParse("projects.list").success).toBe(true);
    expect(AppMethod.safeParse("projects.create").success).toBe(true);
    expect(AppEventMethod.safeParse("project.upserted").success).toBe(true);
    // No update/remove: nothing renames or retires a project yet.
    for (const method of AppMethod.options) {
      expect(method).not.toMatch(/^projects\.(update|remove|delete)$/);
    }
    expect(ProjectUpsertedEvent.parse({ project })).toEqual({ project });
  });

  it("projects.create takes a folder; name and about are optional", () => {
    expect(ProjectsCreateParams.parse({ folder: "~/Code/LilOS" })).toEqual({
      folder: "~/Code/LilOS",
    });
    expect(
      ProjectsCreateParams.parse({ folder: "~/x", name: "  X  ", about: "a" }),
    ).toEqual({ folder: "~/x", name: "X", about: "a" });
    expect(ProjectsCreateParams.safeParse({ name: "no folder" }).success).toBe(
      false,
    );
    expect(ProjectsListParams.safeParse({}).success).toBe(true);
  });
});

describe("D-#771 agent tools", () => {
  it("project_list reads; project_create asks the user (D-#341)", () => {
    expect(LILOS_TOOLS.project_list).toMatchObject({
      area: "project",
      access: "read",
    });
    expect(LILOS_TOOLS.project_create).toMatchObject({
      area: "project",
      access: "approval",
    });
    expect(AGENT_METHOD_TOOLS["projects.list"]).toBe("project_list");
    expect(AGENT_METHOD_TOOLS["projects.create"]).toBe("project_create");
  });

  it("project tools only exist for a session that has the project area", () => {
    expect(toolsForAreas(new Set(["thread"]))).not.toContain("project_list");
    expect(toolsForAreas(new Set(["project"]))).toEqual([
      "project_list",
      "project_create",
    ]);
  });

  it("thread_start takes an optional project (id or key); strict params", () => {
    expect(ThreadStartParams.parse({ text: "go" })).toEqual({ text: "go" });
    expect(ThreadStartParams.parse({ text: "go", project: "LIL" })).toEqual({
      text: "go",
      project: "LIL",
    });
    expect(
      ThreadStartParams.safeParse({ text: "go", project: "" }).success,
    ).toBe(false);
    expect(
      ThreadStartParams.safeParse({ text: "go", cwd: "/etc" }).success,
    ).toBe(false);
    expect(ProjectCreateParams.safeParse({ folder: "~/x" }).success).toBe(true);
    expect(
      ProjectCreateParams.safeParse({ folder: "~/x", id: "proj_1" }).success,
    ).toBe(false);
  });
});
