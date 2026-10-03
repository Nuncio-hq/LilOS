import { UpdateFeed, type UpdateRelease } from "@lilos/contracts/app";

/**
 * Update feed (issue #35): one static JSON next to the release assets.
 * `LILOS_UPDATE_URL` overrides the endpoint (the live test and dev use a
 * local feed); the literal `off` disables updates entirely.
 */
const DEFAULT_FEED_URL =
  "https://github.com/Nuncio-hq/LilOS/releases/latest/download/update-feed.json";

export function resolveFeedUrl(
  env: Record<string, string | undefined>,
): string | undefined {
  const override = env.LILOS_UPDATE_URL;
  if (override === "off") return undefined;
  return override ?? DEFAULT_FEED_URL;
}

export async function fetchLatestRelease(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateRelease> {
  const res = await fetchImpl(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`update feed ${url}: HTTP ${res.status}`);
  return UpdateFeed.parse(await res.json()).latest;
}

/** The release to install, or undefined when current/skipped. */
export function pickUpdate(
  release: UpdateRelease,
  currentBuild: number,
  skippedBuilds: number[],
): UpdateRelease | undefined {
  if (release.build <= currentBuild) return undefined;
  if (skippedBuilds.includes(release.build)) return undefined;
  return release;
}
