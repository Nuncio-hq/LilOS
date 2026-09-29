/**
 * The wired Settings screen (issue #132): the prototype's SettingsView fed
 * from the app's real stores — profile from the relay (#118), detected
 * editors + the stored default from the host/relay (#110), model visibility
 * (#92), live status legs (#53) and versions + the desktop update check
 * (#35). Sections without data simply aren't passed (D-#19) — Approvals
 * waits for #106.
 */
import { formatDiagnostics, toStatusComponents } from "@lilos/client-runtime";
import type { DesktopAbout } from "@lilos/contracts/app";
import { SettingsView, useTheme } from "@lilos/ui";
import type { Human } from "@lilos/ui/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { setDefaultEditor, setModelVisibility } from "../lib/actions";
import { useAtom } from "../lib/hooks";
import { hostEditors, type OsEditor } from "../lib/host";
import { currentCompany, currentMe, osFullName, profile } from "../lib/me";
import {
  engine,
  engineModels,
  engineProviders,
  modelVisibility,
  relay,
} from "../lib/runtime";
import { say } from "../lib/toast";
import {
  aboutLines,
  defaultEditor,
  editorsProps,
  profilePatch,
  type SettingsDraft,
  settledDrafts,
  updateOutcomeMessage,
} from "./state";

export function SettingsPane({ onClose }: { onClose: () => void }) {
  const [theme, setTheme] = useTheme();
  // #118: identity surfaces re-render when the profile or OS name lands.
  useAtom(profile);
  useAtom(osFullName);
  const statusPoll = useAtom(relay.status);
  const relayState = useAtom(relay.state);
  const fatal = useAtom(relay.fatal);
  useAtom(engine.description);
  const catalog = useAtom(engineModels);
  const providers = useAtom(engineProviders);
  const visibility = useAtom(modelVisibility);
  const defaultEd = useAtom(defaultEditor);
  const bridge = window.lilos;

  /* Detected editors — probed per open so a new install shows up. */
  const [editors, setEditors] = useState<OsEditor[] | null>(null);
  useEffect(() => {
    let off = false;
    void hostEditors().then((e) => {
      if (!off) setEditors(e);
    });
    return () => {
      off = true;
    };
  }, []);

  /* Desktop About: the app's own version/build when the bridge has it. */
  const [appAbout, setAppAbout] = useState<DesktopAbout | null>(null);
  useEffect(() => {
    let off = false;
    void bridge
      ?.about?.()
      .then((a) => {
        if (!off) setAppAbout(a);
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, []);

  /* "Check for updates" runs the #35 check and says what it found. */
  const [updateStatus, setUpdateStatus] = useState<string | undefined>();
  const checkUpdates = bridge?.checkUpdate
    ? () => {
        setUpdateStatus("Checking…");
        void bridge
          .checkUpdate?.()
          .then((o) => setUpdateStatus(updateOutcomeMessage(o)))
          .catch(() => setUpdateStatus("Update check failed — try again."));
      }
    : undefined;

  /* General drafts (AC-3): typing edits local state, a 400 ms debounce posts
     profile.update, and the relay's echo (or another window's edit) clears
     each field once the stored value catches up — the round trip never
     fights the keystrokes. */
  const [drafts, setDrafts] = useState<SettingsDraft>({});
  const pendingWrite = useRef<{
    timer: ReturnType<typeof setTimeout>;
    draft: SettingsDraft;
  } | null>(null);
  const queueProfileWrite = (d: SettingsDraft) => {
    if (pendingWrite.current) clearTimeout(pendingWrite.current.timer);
    pendingWrite.current = {
      draft: d,
      timer: setTimeout(() => {
        pendingWrite.current = null;
        const patch = profilePatch(d);
        if (Object.keys(patch).length)
          void relay.updateProfile(patch).catch(() => {});
      }, 400),
    };
  };
  const editDraft = (patch: SettingsDraft) =>
    setDrafts((d) => {
      const next = { ...d, ...patch };
      // Idempotent; React may run this updater twice.
      queueProfileWrite(next);
      return next;
    });
  /* Drop draft fields the store caught up to — subscribe to the atoms so a
     second window's edit settles drafts here too; a pending write flushes
     on close so the last keystrokes aren't lost. */
  useEffect(() => {
    const settle = () =>
      setDrafts((d) => {
        const settled = settledDrafts(d, {
          name: currentMe().name,
          company: currentCompany(),
          color: currentMe().color,
        });
        return Object.keys(settled).length === Object.keys(d).length
          ? d
          : settled;
      });
    const un1 = profile.listen(settle);
    const un2 = osFullName.listen(settle);
    return () => {
      un1();
      un2();
    };
  }, []);
  useEffect(
    () => () => {
      const pending = pendingWrite.current;
      if (pending) {
        clearTimeout(pending.timer);
        const patch = profilePatch(pending.draft);
        if (Object.keys(patch).length)
          void relay.updateProfile(patch).catch(() => {});
      }
    },
    [],
  );

  const me: Human = {
    name: drafts.name ?? currentMe().name,
    color: drafts.color ?? currentMe().color,
  };
  const company = drafts.company ?? currentCompany();

  const comps = useMemo(
    () =>
      toStatusComponents({
        result: statusPoll.result,
        connection: relayState,
        fatal,
      }),
    [statusPoll, relayState, fatal],
  );
  const diagnostics = formatDiagnostics({
    result: statusPoll.result,
    connection: relayState,
    fatal,
    error: statusPoll.error,
    app: { name: "LilOS", version: appAbout?.version },
  });
  const { version, build } = aboutLines({
    app: appAbout,
    versions: statusPoll.result?.versions,
  });
  const editorProps = editorsProps(editors, defaultEd);

  return (
    <SettingsView
      onClose={onClose}
      general={{
        me,
        onMeChange: (m) => editDraft({ name: m.name, color: m.color }),
        company,
        onCompanyChange: (c) => editDraft({ company: c }),
        theme,
        onThemeChange: setTheme,
      }}
      editors={
        editorProps
          ? { ...editorProps, onDefault: (id) => void setDefaultEditor(id) }
          : undefined
      }
      models={
        catalog.length
          ? {
              models: catalog,
              providers: providers.map((p) => ({
                ...p,
                name: p.name ?? p.id,
              })),
              visibility,
              onVisibility: (v) => void setModelVisibility(v),
            }
          : undefined
      }
      status={{
        components: comps,
        diagnostics,
        onCopied: () => say("Diagnostics copied"),
      }}
      about={
        version
          ? {
              version,
              build,
              onCheckUpdates: checkUpdates,
              updateStatus,
            }
          : undefined
      }
    />
  );
}
