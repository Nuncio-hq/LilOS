/**
 * Which engines a bundle ships and which the harness boots by default (#85).
 * The signing identity is the release marker — `sign-local.sh`/`release.yml`
 * pass a Developer ID for releases and `-` for ad-hoc dev builds:
 *
 *   release: Hermes only — a signed DMG has no fake engine inside.
 *   dev (`-`): both engines, with `fake` stamped as the harness default so
 *              the app can label the build "dev · fake engine" (AC-4).
 */

export interface EngineBinary {
  /** Binary name inside Contents/MacOS (auto-discovered by the harness). */
  outfile: string;
  /** Repo-relative serve entry compiled into that binary. */
  entry: string;
}

export interface EngineBundlePlan {
  /** Stamped into the harness as process.env.LILOS_ENGINE_DEFAULT. */
  defaultEngine: "hermes" | "fake";
  binaries: EngineBinary[];
}

const HERMES_ADAPTER: EngineBinary = {
  outfile: "lilos-engine-hermes",
  entry: "packages/engine-hermes/scripts/serve.ts",
};
const FAKE_ADAPTER: EngineBinary = {
  outfile: "lilos-engine-fake",
  entry: "packages/engine-fake/scripts/serve.ts",
};

export function engineBundlePlan(identity: string): EngineBundlePlan {
  return identity === "-"
    ? { defaultEngine: "fake", binaries: [HERMES_ADAPTER, FAKE_ADAPTER] }
    : { defaultEngine: "hermes", binaries: [HERMES_ADAPTER] };
}
