import { skillSlug, type ModelVisibility, type V3DataActions } from "@lilos/ui"
import { MODEL_OPTIONS, modelIdOf, settingsModels, visibilityOf } from "../fake-v3-models"
import { type Engine, patchConnect } from "./context"

/* How long the mock engine takes to re-read its model catalog, and to connect
   one profile after the next. */
const REFRESH_MS = 900
const CONNECT_STEP_MS = 450

/* Settings, first run, and the app around the company: what you choose, who
   you are, the engine's health and its connection to LilOS, and the model
   catalog the pickers share. */
export function settingsActions({ setData, getData, toast, openStatus }: Engine): Pick<
  V3DataActions,
  | "saveSettings"
  | "saveProfile"
  | "finishSetup"
  | "checkEngine"
  | "checkUpdates"
  | "showStatus"
  | "connectEngine"
  | "setModelVisibility"
  | "refreshModels"
  | "addSkill"
> {
  let checking: Promise<void> | undefined
  /* One list hides models for every picker, and Settings shows the same list
     as switches: whichever side changes it, both read the new one. */
  const setVisibility = (v: ModelVisibility) =>
    setData((d) =>
      d.modelCatalog
        ? {
            ...d,
            modelCatalog: { ...d.modelCatalog, visibility: v },
            settings: { ...d.settings, models: settingsModels(d.modelCatalog.options, d.modelCatalog.providers ?? [], v) },
          }
        : d,
    )
  return {
    saveSettings: (patch) => {
      const { models, ...rest } = patch
      setData((d) => ({ ...d, settings: { ...d.settings, ...rest } }))
      const cat = getData().modelCatalog
      if (models && cat) setVisibility(visibilityOf(models, cat.options))
    },
    saveProfile: ({ company, me }) => {
      setData((d) => ({ ...d, company: company?.trim() || d.company, me: me?.trim() || d.me }))
    },
    finishSetup: ({ me, agentName, agentModel }) => {
      setData((d) => ({
        ...d,
        me: me || d.me,
        setUp: true,
        agents: d.agents.map((a) =>
          a.id === d.ceoId
            ? { ...a, name: agentName || a.name, model: agentModel || a.model, modelId: agentModel ? modelIdOf(MODEL_OPTIONS, agentModel) : a.modelId }
            : a,
        ),
      }));
    },
    /* The mock relay and engine come up one after the other (the way the
       first-run check always looked), then settle on what the data says. */
    checkEngine: () =>
      (checking ??= new Promise<void>((done) => {
        const { relay, engine } = getData().settings
        const put = (r: typeof relay, e: typeof engine) =>
          setData((d) => ({ ...d, settings: { ...d.settings, relay: r, engine: e } }))
        put({ state: "starting" }, { ...engine, state: "starting" })
        window.setTimeout(() => put(relay, { ...engine, state: "starting" }), 600)
        window.setTimeout(() => {
          put(relay, engine)
          checking = undefined
          done()
        }, 1400)
      })),
    checkUpdates: () =>
      new Promise<string>((done) =>
        window.setTimeout(() => done("LilOS is up to date."), 1000),
      ),
    showStatus: openStatus,
    /* The one-time approval: from now on every profile is connected, one
       after the other (the harness reconciles them in turn). */
    connectEngine: () => {
      setData((d) => patchConnect(d, (c) => ({ ...c, approved: true, rows: c.rows.map((r) => ({ ...r, state: "updating" as const })) })))
      getData().settings.connect?.rows.forEach((row, i) => {
        window.setTimeout(
          () =>
            setData((d) =>
              patchConnect(d, (c) => ({ ...c, rows: c.rows.map((r) => (r.profile === row.profile ? { ...r, state: "connected" as const } : r)) })),
            ),
          (i + 1) * CONNECT_STEP_MS,
        )
      })
      return Promise.resolve()
    },
    addSkill: ({ name, about, text }) => {
      // The form already shows this slug, and refuses a name the library
      // has. Store that slug; a second row would be the same skill twice.
      const named = skillSlug(name)
      const body = text.trim()
      const line = about.trim()
      if (!named || (!body && !line)) return
      setData((d) => {
        const skills = d.skills ?? []
        if (skills.some((s) => s.name === named || s.id === named)) return d
        return {
          ...d,
          skills: [
            ...skills,
            { id: named, name: named, about: line || named, text: body },
          ],
        }
      })
      // The selected row is the confirmation. A toast would sit on top of it.
    },
    setModelVisibility: setVisibility,
    refreshModels: () =>
      new Promise<void>((done) =>
        window.setTimeout(() => {
          toast("Model list refreshed · nothing new on the engine")
          done()
        }, REFRESH_MS),
      ),
  }
}
