import type { MacDir } from "@lilos/ui-native";

/* The paired Mac's folders as the relay would list them — the same tree
   the web prototype's AddFolderDialog browses (prototype/web/src/App.tsx
   FS). Mock data, not a contract. */

const FS: Record<string, { branch?: string; children?: string[] }> = {
  "~": { children: ["Desktop", "Developer", "Documents"] },
  "~/Desktop": { children: ["Oscar"] },
  "~/Desktop/Oscar": {
    children: ["LilOS", "crew", "ProviderAuthForHarness", "SamProjects"],
  },
  "~/Desktop/Oscar/LilOS": {
    branch: "main",
    children: ["apps", "docs", "packages"],
  },
  "~/Desktop/Oscar/LilOS/apps": { children: [] },
  "~/Desktop/Oscar/LilOS/docs": { children: [] },
  "~/Desktop/Oscar/LilOS/packages": { children: [] },
  "~/Desktop/Oscar/crew": { branch: "main", children: ["src", "docs"] },
  "~/Desktop/Oscar/ProviderAuthForHarness": { children: ["Devin"] },
  "~/Desktop/Oscar/ProviderAuthForHarness/Devin": { children: ["Hermes"] },
  "~/Desktop/Oscar/ProviderAuthForHarness/Devin/Hermes": {
    children: ["agentauth"],
  },
  "~/Desktop/Oscar/ProviderAuthForHarness/Devin/Hermes/agentauth": {
    branch: "main",
    children: ["src"],
  },
  "~/Desktop/Oscar/SamProjects": { children: ["QRit", "qrit-landing"] },
  "~/Desktop/Oscar/SamProjects/QRit": {
    branch: "develop",
    children: ["ios", "web"],
  },
  "~/Desktop/Oscar/SamProjects/qrit-landing": {
    branch: "develop",
    children: ["src"],
  },
  "~/Developer": { children: ["hermes-agent", "scratch"] },
  "~/Developer/hermes-agent": {
    branch: "main",
    children: ["tui_gateway", "hermes_cli"],
  },
  "~/Developer/scratch": { children: [] },
  "~/Documents": { children: ["Notes", "Invoices"] },
  "~/Documents/Notes": { children: [] },
  "~/Documents/Invoices": { children: [] },
};

export const FOUND_REPOS = [
  "~/Desktop/Oscar/crew",
  "~/Desktop/Oscar/SamProjects/qrit-landing",
  "~/Developer/hermes-agent",
].map((path) => ({ path, branch: FS[path]?.branch }));

/** One level, after a short delay like a round trip to the Mac. */
export function readMacDir(path: string): Promise<MacDir | null> {
  const d = FS[path];
  return new Promise((r) =>
    setTimeout(
      () =>
        r(
          d
            ? {
                branch: d.branch,
                folders: (d.children ?? []).map((name) => {
                  const p = `${path}/${name}`;
                  return { name, path: p, branch: FS[p]?.branch };
                }),
              }
            : { folders: [] },
        ),
      220,
    ),
  );
}
