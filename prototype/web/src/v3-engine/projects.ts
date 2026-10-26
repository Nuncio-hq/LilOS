import type { V3DataActions, V3Project, V3Tone } from "@lilos/ui"
import type { Engine } from "./context"

const TONES: V3Tone[] = ["c", "b", "r", "m", "s", "d"]

/* Projects: a folder the company works in (D-#771). "New project from a
   folder…" in a new chat asks for a folder, then the project appears in the
   sidebar and is picked. The real relay does the same: a folder that already
   has a project answers it, and the key is derived from the name. */
export function projectActions({ setData, getData, askForFolder }: Engine): Pick<V3DataActions, "newProject" | "renameProject"> {
  return {
    renameProject: (projectId, name) =>
      setData((d) => ({
        ...d,
        projects: d.projects.map((p) =>
          p.id === projectId && name.trim() ? { ...p, name: name.trim() } : p,
        ),
      })),
    newProject: (onCreated) =>
      askForFolder((path) => {
        const have = getData().projects.find((p) => p.folder === path)
        if (have) return onCreated(have.id)
        const name = path.split("/").filter(Boolean).pop() ?? path
        const letters = name.replace(/[^a-z0-9]/gi, "").toUpperCase() || "P"
        const keys = new Set(getData().projects.map((p) => p.key))
        let key = letters.slice(0, 3)
        for (let n = 2; keys.has(key); n++) key = `${letters.slice(0, 2)}${n}`
        const project: V3Project = {
          id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          name,
          key,
          tone: TONES[getData().projects.length % TONES.length],
          folder: path,
          about: "",
        }
        setData((d) => ({ ...d, projects: [...d.projects, project] }))
        onCreated(project.id)
      }),
  }
}
