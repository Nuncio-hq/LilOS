/**
 * The folders macOS puts behind a TCC "Files and Folders" consent (D-#875):
 * an `open()`/`readdir()` inside one blocks until the responsible app —
 * LilOS.app — is granted, and under launchd the prompt can't even be
 * answered, so the read hangs forever. The names are wire data (the
 * desktop shell's ask-step names them, the FOLDER_ACCESS error names them)
 * so the one copy lives in contracts.
 */
export const PROTECTED_FOLDERS = ["Desktop", "Documents", "Downloads"] as const;
export type ProtectedFolder = (typeof PROTECTED_FOLDERS)[number];

/** The protected folder `abs` sits inside, if any
 *  (`/u/o/Desktop/x` → "Desktop"). */
export function protectedFolderOf(
  abs: string,
  home: string,
): ProtectedFolder | undefined {
  for (const name of PROTECTED_FOLDERS) {
    // String join, not node:path — contracts are bundled into the mobile
    // app where node builtins don't resolve.
    const root = `${home}/${name}`;
    if (abs === root || abs.startsWith(`${root}/`)) return name;
  }
  return undefined;
}

/** The one sentence a blocked probe reports (D-#875): "waiting on macOS
 *  folder access for your Desktop folder" when the path names a protected
 *  folder, else the path itself. */
export function folderAccessMessage(abs: string, home: string): string {
  const folder = protectedFolderOf(abs, home);
  return `waiting on macOS folder access for ${folder ? `your ${folder} folder` : abs}`;
}
