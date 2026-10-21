import { AddFolderDialog, type FsDir, NEW_PROJECT_COPY } from "@lilos/ui"

/* The folder picker the real app draws beside the shell ("New project from a
   folder…"): the same dialog, over a small made-up disk. Folders that are
   already projects, and a couple that are not yet, so both ends of the flow
   can be tried. */

const repo = (branch = "main"): FsDir => ({ git: { branches: [branch] } })

const DISK: Record<string, FsDir> = {
  "~": { children: ["Code", "Documents", "Desktop"] },
  "~/Code": { children: ["LilOS", "heardback", "qrit", "journal-app", "dotfiles"] },
  "~/Code/LilOS": repo(),
  "~/Code/heardback": repo(),
  "~/Code/qrit": repo(),
  "~/Code/journal-app": repo("trunk"),
  "~/Code/dotfiles": {},
  "~/Documents": { children: [] },
  "~/Desktop": { children: [] },
}

/** Found on this Mac: what the scan turned up. */
const FOUND = ["~/Code/journal-app", "~/Code/dotfiles", "~/Code/LilOS", "~/Code/heardback", "~/Code/qrit"]

export function FolderDialog({ onPick, onClose }: { onPick: (path: string) => void; onClose: () => void }) {
  return (
    <AddFolderDialog
      folders={[]}
      copy={NEW_PROJECT_COPY}
      fs={DISK}
      discovered={FOUND}
      onClose={onClose}
      onAdd={(path) => {
        onClose()
        onPick(path)
      }}
    />
  )
}
