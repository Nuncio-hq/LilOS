import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Host-target compiles of every bun-compiled bundle binary, for the packaged
 * smoke (#539 AC-3/AC-5): `build:harness` compiles the darwin artifact the
 * release path uses, but only a host binary can RUN on the CI runner the
 * check executes on — the smoke then boots these with the repo hidden.
 *
 *   bun scripts/ci/build-smoke-bins.ts [outdir]
 *
 * Coverage notes: `lilos-svc` is a swiftc binary, so it exists only inside
 * the .app — the release-path smoke (scripts/release/sign-local.sh) is the
 * leg that runs it. `lilos-harness-check`, the artifact `build:harness` is
 * named for, is a darwin-target binary: it is compiled (so a compile break
 * still fails here) but intentionally not run on the host — the host-target
 * `lilos-harness` above stands in for its runtime.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(
  process.argv[2] ?? join(REPO, "apps", "desktop", "build", "smoke"),
);
mkdirSync(OUT, { recursive: true });

const run = (args: string[]) => {
  console.log(`$ bun ${args.join(" ")}`);
  execFileSync("bun", args, { stdio: "inherit" });
};

const host = ["--compile", "--target=bun"];
run([
  "build",
  join(REPO, "apps/relay/src/index.ts"),
  ...host,
  "--outfile",
  join(OUT, "lilos-relay"),
]);
run([
  join(REPO, "apps/harness/scripts/compile.ts"),
  join(OUT, "lilos-harness"),
  "--target=bun",
]);
for (const [entry, outfile] of [
  ["packages/engine-fake/scripts/serve.ts", "lilos-engine-fake"],
  ["packages/engine-hermes/scripts/serve.ts", "lilos-engine-nous"],
] as const) {
  run(["build", join(REPO, entry), ...host, "--outfile", join(OUT, outfile)]);
}
