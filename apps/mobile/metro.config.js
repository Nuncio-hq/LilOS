// Bun workspaces install `apps/mobile`'s deps into the repo-root node_modules
// and link workspace packages (@lilos/*) through it. Metro's defaults only
// look beside the app, so: watch the whole repo and resolve from both roots —
// the app's own node_modules first, then the workspace root's.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const appRoot = __dirname;
const workspaceRoot = path.resolve(appRoot, "../..");

const config = getDefaultConfig(appRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(appRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// Dev-only tooling (#397): the netspy counter + badge are __DEV__ evidence
// for the offline demo. `if (__DEV__)` keeps them from *running* in release
// but Metro still bundles statically-imported modules, so a release
// (dev=false) resolution maps them to Metro's empty module — the shipped
// bundle carries none of it. Matched on the resolved path so every
// specifier form catches it.
const DEV_ONLY_FILES = new Set([
  path.join(appRoot, "src", "netspy.ts"),
  path.join(appRoot, "src", "netspy-badge.tsx"),
]);

// Workspace packages ship TypeScript source (no dist step) whose imports use
// NodeNext "./x.js" specifiers. Metro can't map those to the .ts sibling, so
// on a miss retry with the extension stripped and let sourceExts find it.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest;
  try {
    const resolution = resolve(context, moduleName, platform);
    if (
      context.dev === false &&
      resolution.type === "sourceFile" &&
      DEV_ONLY_FILES.has(resolution.filePath)
    ) {
      return { type: "empty" };
    }
    return resolution;
  } catch (error) {
    if (moduleName.endsWith(".js")) {
      return resolve(context, moduleName.slice(0, -3), platform);
    }
    throw error;
  }
};

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-types.d.ts",
});
