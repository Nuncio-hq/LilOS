import { RelayError } from "@lilos/client-runtime";
import { pairingUrl, type V3DataActions } from "@lilos/ui";
import {
  fixEnginePolicy,
  setDefaultAccess,
  setDefaultEditor,
  setModelVisibility,
  toastOnFail,
} from "../lib/actions";
import { requestConnect } from "../lib/connect";
import { hireEmployee } from "../lib/employees";
import { addFolder } from "../lib/folders";
import { DEFAULT_AVATAR_COLOR } from "../lib/me";
import { engineModels, modelVisibility, relay } from "../lib/runtime";
import {
  $scheduledTasks,
  createScheduledTask,
  deleteScheduledTask,
  runScheduledTaskNow,
  updateScheduledTask,
} from "../lib/schedules";
import { say, sayError } from "../lib/toast";
import { profilePatch, updateOutcomeMessage } from "../settings/state";
import { modelLabel, pickFromLabel } from "./models";
import { detectedEditors, markOnboarded } from "./settings-data";
import { visibilityOf } from "./settings-map";

/* What v3 Settings, the schedule editor and first run change, through the
   calls the app already has. A failure says so in a toast; nothing here
   pretends to have worked. */

type Mine = Pick<
  V3DataActions,
  | "pairPhone"
  | "unpairPhone"
  | "disablePhoneAccess"
  | "saveSettings"
  | "saveProfile"
  | "checkEngine"
  | "checkUpdates"
  | "connectEngine"
  | "fixEnginePolicy"
  | "finishSetup"
  | "skipSetup"
  | "scheduleSave"
  | "scheduleToggle"
  | "scheduleRunNow"
  | "scheduleDelete"
>;

/** First run's agent: the engine already hired its default one the first
    time it came up (the harness does, when the roster is empty), so what you
    chose renames and pins that one; only an empty roster hires. A model that
    is the engine's own default stays unpinned: the engine owns defaults. */
async function firstAgent(name: string | undefined, label: string | undefined) {
  const pick =
    label && label !== modelLabel("") ? pickFromLabel(label) : undefined;
  const first = relay.employees.get()[0];
  if (!first) {
    await hireEmployee(
      {
        name: name || "Assistant",
        role: "",
        instructions: "",
        model: pick?.model ?? "",
        ...(pick?.provider ? { provider: pick.provider } : {}),
      },
      null,
    );
    return;
  }
  const rename = name && name !== first.name ? { name } : {};
  const pin = pick ? { model: pick.model } : {};
  if (Object.keys(rename).length + Object.keys(pin).length > 0)
    await relay.updateEmployee(first.id, { ...rename, ...pin });
}

export const v3SettingsActions: Mine = {
  pairPhone: async () => {
    try {
      const offer = await relay.pairingOffer();
      return {
        kind: "ready",
        offer: {
          host: offer.host,
          code: offer.code,
          expiresAt: offer.expiresAt,
          url: pairingUrl(offer),
        },
      };
    } catch (e) {
      if (e instanceof RelayError && e.code === "tailscale_unavailable")
        return { kind: "no-remote" };
      sayError("Couldn't reach the relay — try again.");
      throw e;
    }
  },
  unpairPhone: (deviceId) =>
    void relay
      .revokeDevice(deviceId)
      .catch(() => sayError("Couldn't remove that phone — try again.")),
  disablePhoneAccess: () =>
    void relay
      .pairingDisable()
      .catch(() => sayError("Couldn't turn off phone access — try again.")),

  saveSettings: (patch) => {
    if (patch.approvals)
      toastOnFail(
        "Couldn't save that setting",
        setDefaultAccess(patch.approvals),
      );
    const editor = detectedEditors.get()?.find((e) => e.name === patch.editor);
    if (editor)
      toastOnFail("Couldn't save that setting", setDefaultEditor(editor.id));
    if (patch.models)
      toastOnFail(
        "Couldn't save that setting",
        setModelVisibility(
          visibilityOf(patch.models, engineModels.get(), modelVisibility.get()),
        ),
      );
  },
  saveProfile: ({ company, me }) =>
    toastOnFail(
      "Couldn't save that",
      relay.updateProfile(profilePatch({ company, name: me })),
    ),

  checkEngine: () => relay.refreshSystemStatus(),
  ...(window.lilos?.checkUpdate
    ? {
        checkUpdates: async () => {
          try {
            return updateOutcomeMessage(
              (await window.lilos?.checkUpdate?.()) ?? "failed",
            );
          } catch {
            return updateOutcomeMessage("failed");
          }
        },
      }
    : {}),
  connectEngine: async () => {
    try {
      await requestConnect();
    } catch (e) {
      sayError("Couldn't connect — try again.");
      throw e;
    }
  },
  /* #884: the warning's one-click repair — `smart`, once, on the click;
     the next describe probe confirms what the optimistic patch showed. */
  fixEnginePolicy: () =>
    toastOnFail("Couldn't update that setting", fixEnginePolicy()),

  finishSetup: async ({ company, me, agentName, agentModel, folder }) => {
    const steps = await Promise.allSettled([
      relay.updateProfile({
        userName: me,
        companyName: company || undefined,
        avatarColor: DEFAULT_AVATAR_COLOR,
      }),
      firstAgent(agentName, agentModel),
      // The first folder is the company's first project (D-#771).
      folder
        ? addFolder(folder).then(() => relay.createProject({ folder }))
        : Promise.resolve(),
    ]);
    const failed = steps.filter((s) => s.status === "rejected").length;
    // Only when nothing saved does the welcome stay (it says so itself).
    if (failed === steps.length) throw new Error("setup saved nothing");
    markOnboarded();
    if (failed > 0)
      sayError("Part of that didn't save. Check Settings and your agents.");
    else say("All set");
  },
  skipSetup: markOnboarded,

  scheduleSave: (s) => {
    const existing = $scheduledTasks.get().find((t) => t.id === s.id);
    const body = {
      name: s.title,
      prompt: s.prompt,
      schedule: s.when,
      access: s.fullAccess ? ("full" as const) : ("ask" as const),
    };
    const fail = "Couldn't save that schedule";
    if (!existing) {
      toastOnFail(
        fail,
        createScheduledTask({
          employeeId: s.agentId,
          ...body,
          ...(s.folder ? { folder: s.folder } : {}),
        }),
      );
    } else if (existing.employeeId !== s.agentId) {
      // A task cannot change hands: the new agent gets it, the old one's goes.
      toastOnFail(
        fail,
        (async () => {
          const made = await createScheduledTask({
            employeeId: s.agentId,
            ...body,
            ...(s.folder ? { folder: s.folder } : {}),
          });
          if (existing.paused)
            await updateScheduledTask(made.id, { paused: true });
          await deleteScheduledTask(existing.id);
        })(),
      );
    } else {
      toastOnFail(
        fail,
        updateScheduledTask(existing.id, { ...body, folder: s.folder ?? null }),
      );
    }
  },
  scheduleToggle: (id) => {
    const task = $scheduledTasks.get().find((t) => t.id === id);
    if (task)
      toastOnFail(
        "Couldn't update that schedule",
        updateScheduledTask(id, { paused: !task.paused }),
      );
  },
  scheduleRunNow: (id) =>
    toastOnFail("Couldn't run that schedule", runScheduledTaskNow(id)),
  scheduleDelete: (id) =>
    toastOnFail("Couldn't delete that schedule", deleteScheduledTask(id)),
};
