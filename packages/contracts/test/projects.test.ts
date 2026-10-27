import { describe, expect, it } from "vitest";
import {
  AppEventMethod,
  AppMethod,
  Conversation,
  Project,
  ProjectRemovedEvent,
  ProjectsCreateParams,
  ProjectsListParams,
  ProjectsRemoveParams,
  ProjectUpsertedEvent,
} from "../src/app/index.js";
import {
  AGENT_METHOD_TOOLS,
  LILOS_TOOLS,
  NOT_AGENT_FACING,
  ProjectCreateParams,
  ThreadStartParams,
  toolsForAreas,
} from "../src/harness/index.js";

/* D-#854: projects on the wire and in the agent catalog — made and
   removed by hand, never inferred from a folder being used. */

const project = {
  id: "proj_1",
  name: "LilOS",
  key: "LIL",
  folder: "/Users/ada/Code/LilOS",
  about: "The company OS.",
  createdAt: 1,
};

describe("D-#854 Project record", () => {
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

describe("D-#854 wire", () => {
  it("declares projects.list / create / remove and the project events", () => {
    expect(AppMethod.safeParse("projects.list").success).toBe(true);
    expect(AppMethod.safeParse("projects.create").success).toBe(true);
    expect(AppMethod.safeParse("projects.remove").success).toBe(true);
    expect(AppEventMethod.safeParse("project.upserted").success).toBe(true);
    expect(AppEventMethod.safeParse("project.removed").success).toBe(true);
    // No update: a project is named at create time.
    for (const method of AppMethod.options) {
      expect(method).not.toMatch(/^projects\.(update|delete)$/);
    }
    expect(ProjectUpsertedEvent.parse({ project })).toEqual({ project });
    expect(ProjectRemovedEvent.parse({ projectId: project.id })).toEqual({
      projectId: project.id,
    });
  });

  it("projects.create takes a folder; name, key and about are optional", () => {
    expect(ProjectsCreateParams.parse({ folder: "~/Code/LilOS" })).toEqual({
      folder: "~/Code/LilOS",
    });
    expect(
      ProjectsCreateParams.parse({
        folder: "~/x",
        name: "  X  ",
        key: "X2",
        about: "a",
      }),
    ).toEqual({ folder: "~/x", name: "X", key: "X2", about: "a" });
    expect(ProjectsCreateParams.safeParse({ name: "no folder" }).success).toBe(
      false,
    );
    expect(ProjectsListParams.safeParse({}).success).toBe(true);
  });

  it("projects.remove takes the project by id or key", () => {
    expect(ProjectsRemoveParams.parse({ id: "proj_1" })).toEqual({
      id: "proj_1",
    });
    expect(ProjectsRemoveParams.safeParse({}).success).toBe(false);
  });
});

describe("D-#854 agent tools", () => {
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
    /* Removing a project unfilings Oscar's threads — no agent tool; it is
       listed in NOT_AGENT_FACING instead (D-#854). */
    expect(NOT_AGENT_FACING["projects.remove"]).toMatch(/project/);
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
