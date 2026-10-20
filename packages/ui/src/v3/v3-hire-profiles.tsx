import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Btn, Section } from "./v3-bits";
import { Avatar } from "./v3-marks";
import type { V3PageProps } from "./v3-page-types";
import type { V3Profile } from "./v3-types";

/* The Hire page's quiet second way in: a profile the engine already has (made
   in the engine's own app, or left behind by an agent that was removed:
   removing never deletes a profile, D-#29). Hiring one links it. The agent
   keeps the profile's own persona, model and skills, which the engine owns,
   so the form asks only for what the company record holds: a name and a role.
   Without `listProfiles` and `hireProfile` the section is not drawn. */

const INPUT =
  "mt-1 h-8 w-full rounded-[7px] border border-foreground/15 bg-background px-2.5 text-[14px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-foreground/40";

const LABEL = "text-[13px] text-muted-foreground";

export function ExistingProfiles({
  data,
  go,
  act,
  selected,
  onSelect,
}: V3PageProps & {
  /** The profile whose form is open, by id. */
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [profiles, setProfiles] = useState<V3Profile[]>();
  // Read once per visit: a profile made or freed elsewhere shows up on the
  // next one. A failed read has already come back as an empty list.
  useEffect(() => {
    let live = true;
    void act.listProfiles?.().then(
      (p) => live && setProfiles(p),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  // A profile an agent already runs on is not offered twice.
  const hirable = (profiles ?? []).filter(
    (p) => !data.agents.some((a) => a.profile === p.id),
  );
  if (!act.hireProfile || hirable.length === 0) return null;

  return (
    <section aria-label="Existing engine profiles">
      <Section title="Or bring in an existing profile" count={hirable.length} />
      <p className="mb-2 text-[13px] text-muted-foreground">
        The engine already has these. A profile keeps its own persona, model and
        skills; LilOS only adds it to the company.
      </p>
      <div className="border-[var(--v3-line)] border-t">
        {hirable.map((p) => {
          const on = selected === p.id;
          return (
            <div key={p.id} className="border-[var(--v3-line)] border-b">
              <button
                type="button"
                aria-expanded={on}
                onClick={() => onSelect(on ? null : p.id)}
                className={cn(
                  "-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-[var(--v3-hover)]",
                  on && "bg-[var(--v3-soft)]",
                )}
              >
                <Avatar name={p.name} tone="n" size={22} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] text-foreground">
                    {p.name}
                    {p.id.toLowerCase() !== p.name.toLowerCase() && (
                      <span className="ml-2 font-mono text-[12.5px] text-muted-foreground">
                        {p.id}
                      </span>
                    )}
                  </span>
                  {p.description && (
                    <span className="block truncate text-[13px] text-muted-foreground">
                      {p.description}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[13px] text-muted-foreground">
                  {p.skills} {p.skills === 1 ? "skill" : "skills"}
                </span>
              </button>
              {on && <ProfileForm profile={p} go={go} act={act} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ProfileForm({
  profile,
  go,
  act,
}: Pick<V3PageProps, "go" | "act"> & { profile: V3Profile }) {
  const [name, setName] = useState(profile.name);
  // The engine's one line about the profile is what its first hire took for a
  // role too (the harness's own first-run hire does the same); it is a start,
  // not a rule.
  const [role, setRole] = useState(profile.description ?? "");
  // A second click while the hire is in flight must not hire a duplicate.
  const hiring = useRef(false);

  // Lands on the new agent, opened beside People. A failed hire has already
  // been explained by the app, so the form just stays as it is.
  function submit() {
    const trimmed = name.trim();
    if (!act.hireProfile || !trimmed || hiring.current) return;
    hiring.current = true;
    act
      .hireProfile({ profile: profile.id, name: trimmed, role: role.trim() })
      .then((id) => {
        go({ page: "people" });
        go({ page: "agent", id });
      })
      .catch(() => {})
      .finally(() => {
        hiring.current = false;
      });
  }

  return (
    <form
      className="mt-1 mb-4 max-w-[520px] space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="block">
        <span className={LABEL}>Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          className={INPUT}
        />
      </label>
      <label className="block">
        <span className={LABEL}>Role</span>
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="What it does"
          className={INPUT}
        />
      </label>
      {/* What the engine keeps owning, shown so the choice is informed. */}
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13.5px]">
        {profile.model && (
          <>
            <dt className="text-muted-foreground">Model</dt>
            <dd className="text-foreground">{profile.model}</dd>
          </>
        )}
        {profile.soul && (
          <>
            <dt className="text-muted-foreground">Persona</dt>
            <dd className="line-clamp-2 text-foreground">{profile.soul}</dd>
          </>
        )}
      </dl>
      <div className="pt-1">
        <Btn primary onClick={submit}>
          Hire
        </Btn>
      </div>
    </form>
  );
}
