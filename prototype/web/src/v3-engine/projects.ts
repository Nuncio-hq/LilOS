import { suggestProjectKey, type V3DataActions, type V3Project, type V3Thread, type V3Tone } from "@lilos/ui"
import { projectForFolder } from "@lilos/ui/v3-data"
import type { Engine } from "./context"

const TONES: V3Tone[] = ["c", "b", "r", "m", "s", "d"]

/* Projects: a folder the company works in (D-#771). Nothing makes one on
   its own — you add one (the sidebar's + or "New project from a folder…"),
   or a chat's folder chip makes one of the folder it already runs in
   (#854). A folder that already has a project answers it. The key follows
   the name, deduped against the projects there are. */
const makeProject = (
  d: ReturnType<Engine["getData"]>,
  path: string,
  name: string,
  key: string,
): V3Project => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  let id = base
  for (let n = 2; d.projects.some((p) => p.id === id); n += 1)
    id = `${base}-${n}`
  return {
    id,
    name,
    key,
    tone: TONES[d.projects.length % TONES.length],
    folder: path,
    about: "",
  }
}

/* A key nobody has: the suggestion, then JO2, JO3, … until free. */
const freeKey = (d: ReturnType<Engine["getData"]>, key: string): string => {
  const keys = new Set(d.projects.map((p) => p.key))
  if (!keys.has(key)) return key
  const head = key.slice(0, 2) || "P"
  let n = 2
  while (keys.has(`${head}${n}`)) n += 1
  return `${head}${n}`
}

export function projectActions({
  setData,
  getData,
  askForFolder,
  toast,
}: Engine): Pick<
  V3DataActions,
  "newProject" | "addAsProject" | "removeProject"
> {
  return {
    newProject: (onCreated) =>
      askForFolder((path, fields) => {
        const have = projectForFolder(getData(), path)
        if (have && have.folder === path) return onCreated(have.id)
        const name =
          fields?.name?.trim() ||
          path.split("/").filter(Boolean).pop() ||
          path
        const key = freeKey(
          getData(),
          (fields?.key?.trim() || suggestProjectKey(name)).toUpperCase(),
        )
        const project = makeProject(getData(), path, name, key)
        setData((d) => ({
          ...d,
          projects: [...d.projects, project],
          // The folder is known now: the new-chat box can name its branch.
          folders: d.folders?.some((f) => f.path === path)
            ? d.folders
            : [...(d.folders ?? []), { path, label: name }],
        }))
        toast(`${name} is a project now`)
        onCreated(project.id)
      }),
    // "Add as project" on a folder chip: same make, one click — the threads
    // running in the folder file under it on their own (containment, #854).
    addAsProject: (folder) => {
      if (projectForFolder(getData(), folder)) return
      const name = folder.split("/").filter(Boolean).pop() ?? folder
      const project = makeProject(
        getData(),
        folder,
        name,
        freeKey(getData(), suggestProjectKey(name)),
      )
      setData((d) => ({
        ...d,
        projects: [...d.projects, project],
        folders: d.folders?.some((f) => f.path === folder)
          ? d.folders
          : [...(d.folders ?? []), { path: folder, label: name }],
      }))
      toast(`${name} is a project now — its threads file under it`)
    },
    // Remove project: the folder and the threads stay — nothing on disk is
    // touched — and the threads file as chats again (their folder is just a
    // folder once the record is gone). Tickets keep their record; what the
    // paused layer does with them is the backend slice's (#854).
    removeProject: (projectId) => {
      const project = getData().projects.find((p) => p.id === projectId)
      if (!project) return Promise.resolve()
      const keep = (t: V3Thread): V3Thread =>
        t.projectId === projectId ? { ...t, projectId: undefined } : t
      setData((d) => ({
        ...d,
        projects: d.projects.filter((p) => p.id !== projectId),
        threads: d.threads.map(keep),
        archivedThreads: d.archivedThreads?.map(keep),
      }))
      toast(`${project.name} is a folder again — its threads are chats now`)
      return Promise.resolve()
    },
  }
}
