import { existsSync, promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import type {
  OsEditor,
  OsEditorId,
  OsEditorsResult,
  OsOpenParams,
  OsOpenResult,
} from "@lilos/contracts/host";
import { HOST_ERRORS, HostError } from "./errors.js";
import { run } from "./exec.js";
import { expandPath } from "./paths.js";

/** How the editor's bundled CLI expresses "open at line". */
type LineSyntax = "-g" | "colon" | "none";

/** Editors LilOS can open, in default-preference order (first found is the
   default until the #132 picker). Detection is by bundle id: a `.app` counts
   when its `Contents/Info.plist` declares this CFBundleIdentifier — read as
   raw bytes, which holds for both XML and binary plists. */
export const EDITOR_CATALOG: {
  id: OsEditorId;
  name: string;
  bundleId: string;
  /** Launcher inside the bundle; absent → fall back to `open -a`. */
  cli?: string;
  line: LineSyntax;
}[] = [
  {
    id: "vscode",
    name: "VS Code",
    bundleId: "com.microsoft.VSCode",
    cli: "Contents/Resources/app/bin/code",
    line: "-g",
  },
  {
    id: "cursor",
    name: "Cursor",
    bundleId: "com.todesktop.230313mzl4wtc92lm",
    cli: "Contents/Resources/app/bin/cursor",
    line: "-g",
  },
  {
    id: "zed",
    name: "Zed",
    bundleId: "dev.zed.Zed",
    cli: "Contents/MacOS/cli",
    line: "colon",
  },
  {
    id: "xcode",
    name: "Xcode",
    bundleId: "com.apple.dt.Xcode",
    cli: "Contents/Developer/usr/bin/xed",
    line: "none",
  },
];

const APP_SCAN_CAP = 256;

/** App dirs os.editors scans; LILOS_APP_DIRS (":"-separated) overrides — the
   seam e2e/vitest use to plant fake bundles (same idea as fake-gh on PATH). */
export function appDirs(): string[] {
  const env = process.env.LILOS_APP_DIRS;
  if (env?.trim())
    return env
      .split(":")
      .filter(Boolean)
      .map((p) => expandPath(p));
  return ["/Applications", join(homedir(), "Applications")];
}

/** Does this .app declare `bundleId`? The id is embedded in Info.plist as
   UTF-8 whether the plist is XML or binary, so a byte search answers both. */
async function declaresBundleId(
  app: string,
  bundleId: string,
): Promise<boolean> {
  const plist = await fsp
    .readFile(join(app, "Contents", "Info.plist"))
    .catch(() => null);
  return plist?.includes(bundleId) ?? false;
}

/** Scan the app dirs for the catalog's editors; first dir wins per editor,
   and the result is re-sorted into catalog (preference) order. */
export async function detectEditors(
  dirs: string[] = appDirs(),
): Promise<OsEditor[]> {
  const found = new Map<OsEditorId, OsEditor>();
  for (const dir of dirs) {
    const names = await fsp
      .readdir(dir)
      .then((n) => n.slice(0, APP_SCAN_CAP))
      .catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".app")) continue;
      const app = join(dir, name);
      for (const e of EDITOR_CATALOG) {
        if (!found.has(e.id) && (await declaresBundleId(app, e.bundleId)))
          found.set(e.id, { id: e.id, name: e.name, app });
      }
    }
  }
  return EDITOR_CATALOG.flatMap((e) => {
    const hit = found.get(e.id);
    return hit ? [hit] : [];
  });
}

export async function osEditors(): Promise<OsEditorsResult> {
  return { editors: await detectEditors() };
}

/**
 * Pure argv plan for one open — the `-g`/`colon` line syntax lives here and
 * nowhere else, so the AC test can pin every editor's args without launching
 * anything. No shell: every arg is an array element (a path with spaces
 * stays one arg). `open` is PATH-resolved so e2e can plant a fake.
 */
export function openPlan(
  app: OsOpenParams["app"],
  editor: OsEditor | undefined,
  target: string,
  line?: number,
): { cmd: string; args: string[] } {
  if (app === "finder") return { cmd: "open", args: ["-R", target] };
  const entry = EDITOR_CATALOG.find((e) => e.id === app);
  if (!entry || !editor)
    throw new HostError(HOST_ERRORS.APP_NOT_FOUND, `no such editor: ${app}`);
  const cli = entry.cli ? join(editor.app, entry.cli) : null;
  if (cli && existsSync(cli)) {
    // Xcode's xed opens the file only (issue #110); `-g`/`colon` add `:line`.
    if (entry.line === "-g")
      return { cmd: cli, args: ["-g", line ? `${target}:${line}` : target] };
    if (entry.line === "colon")
      return { cmd: cli, args: [line ? `${target}:${line}` : target] };
    return { cmd: cli, args: [target] };
  }
  return { cmd: "open", args: ["-a", editor.app, target] };
}

export async function osOpen(params: OsOpenParams): Promise<OsOpenResult> {
  const root = await fsp.realpath(expandPath(params.root)).catch(() => {
    throw new HostError(
      HOST_ERRORS.PATH_NOT_FOUND,
      `no such folder: ${params.root}`,
    );
  });
  const abs = isAbsolute(params.path)
    ? normalize(params.path)
    : join(root, params.path);
  // Containment is lexical first: a `..` escape is refused whether or not
  // the target exists; then the realpath pass catches symlink escapes.
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new HostError(
      HOST_ERRORS.OUTSIDE_ROOT,
      `${params.path} escapes ${params.root}`,
    );
  }
  const target = await fsp.realpath(abs).catch(() => {
    throw new HostError(
      HOST_ERRORS.PATH_NOT_FOUND,
      `no such path: ${params.path}`,
    );
  });
  if (target !== root && !target.startsWith(root + sep)) {
    throw new HostError(
      HOST_ERRORS.OUTSIDE_ROOT,
      `${params.path} escapes ${params.root}`,
    );
  }
  const editor =
    params.app === "finder"
      ? undefined
      : (await detectEditors()).find((e) => e.id === params.app);
  const { cmd, args } = openPlan(params.app, editor, target, params.line);
  try {
    await run(cmd, args);
  } catch (e) {
    const detail =
      e instanceof Error && "stderr" in e && e.stderr
        ? String(e.stderr)
        : e instanceof Error
          ? e.message
          : String(e);
    throw new HostError(HOST_ERRORS.OPEN_FAILED, `${cmd} failed`, {
      detail: detail.slice(0, 400),
    });
  }
  return {};
}
