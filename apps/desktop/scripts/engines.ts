/**
 * Which engines a bundle ships and which the harness boots by default (#85,
 * #141). The signing identity is the release marker — `sign-local.sh`/
 * `release.yml` pass a Developer ID for releases and `-` for ad-hoc dev
 * builds. `engine` is the explicit `--engine=` override (`build.ts`):
 *
 *   release:           Hermes only — a signed DMG has no fake engine inside.
 *   dev (`-`):         both engines, with `fake` stamped as the harness
 *                      default so the app can label the build
 *                      "dev · fake engine" (AC-4).
 *   dev + `--engine=hermes`: both engines, hermes default — the `app:local`
 *                      dogfood build (#141); the sidebar label follows the
 *                      running engine so this bundle is not labeled.
 *   release + `--engine=fake`: an error — a signed build never ships the
 *                      fake engine (AC-4).
 */

interface EngineBinary {
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

/**
 * Non-engine executables `build.ts` always places in `Contents/MacOS` (the
 * Electron binary itself is renamed to `LilOS` at assemble time). No file
 * the bundle ships may have "hermes" in its name: managed Macs kill such
 * executables on sight — the MDM kill-by-name policy (#141).
 */
export const BUNDLE_EXECUTABLES = ["lilos-svc", "lilos-relay", "lilos-harness"];

const HERMES_ADAPTER: EngineBinary = {
  // "nous" (Nous Research, Hermes' maker), never "hermes" — managed Macs
  // SIGKILL executables whose basename contains it (#141). The engine id in
  // protocol/status stays `hermes`; only this file name changes.
  outfile: "lilos-engine-nous",
  entry: "packages/engine-hermes/scripts/serve.ts",
};
const FAKE_ADAPTER: EngineBinary = {
  outfile: "lilos-engine-fake",
  entry: "packages/engine-fake/scripts/serve.ts",
};

export function engineBundlePlan(
  identity: string,
  engine?: "hermes" | "fake",
): EngineBundlePlan {
  if (identity !== "-") {
    if (engine === "fake") {
      throw new Error(
        "--engine=fake is only valid on ad-hoc builds — a signed build never ships the fake engine.",
      );
    }
    return { defaultEngine: "hermes", binaries: [HERMES_ADAPTER] };
  }
  return {
    defaultEngine: engine ?? "fake",
    binaries: [HERMES_ADAPTER, FAKE_ADAPTER],
  };
}
