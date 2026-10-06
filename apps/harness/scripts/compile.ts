import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one `bun build --compile` invocation for `lilos-harness` — shared by the
 * packaged bundle (apps/desktop/scripts/build.ts) and the PR-time
 * `bun run build:harness` smoke, so a graph change that breaks --compile fails
 * CI instead of the release build (#388).
 *
 *   bun apps/harness/scripts/compile.ts <outfile> [extra bun build args...]
 */
const [outfile, ...extra] = process.argv.slice(2);
if (!outfile) {
  console.error("usage: compile.ts <outfile> [extra bun build args]");
  process.exit(1);
}
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
mkdirSync(dirname(outfile), { recursive: true });
/* The release target is the default; the #539 smoke passes --target=bun to
   get a host binary it can actually run on the CI runner. */
const hasTarget = extra.some((a) => a.startsWith("--target"));
execFileSync(
  "bun",
  [
    "build",
    join(REPO, "apps", "harness", "src", "index.ts"),
    "--compile",
    ...(hasTarget ? [] : ["--target=bun-darwin-arm64"]),
    /* playwright-core lazily requires chromium-bidi inside init_bidiOverCdp —
       the BiDi transport only; the browser surface drives Chromium over CDP
       and never loads it. chromium-bidi isn't installed, so the bundler can't
       resolve it: mark it external — the require never runs at runtime. */
    "--external",
    "chromium-bidi",
    ...extra,
    "--outfile",
    outfile,
  ],
  { stdio: "inherit" },
);
